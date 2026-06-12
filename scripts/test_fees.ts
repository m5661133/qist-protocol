import { ethers } from "hardhat";

const PROXY       = "0x027C5f1aFBD9FCef650E135794E3AB865180bC8A";
const USDC_ADDR   = "0x5fEEA8Ca3B4d342082Fff03D24934375c5e594D9";
const WBTC_ADDR   = "0x0C0114d6A15BBa02a7ef89894462d52eE5F283A7";
// عنوان "الطرف الثالث" — محفظة المشتري كـ Broker للاختبار
const BROKER_THIRD_PARTY = "0xBaA8CeF9f1CE60aed41D62ca12Fe490691697d74";

const ABI = [
  "function createOffer(address,address,address,uint256,uint16,uint8,uint8,uint32,uint256,uint16) payable returns (uint256)",
  "function buy(uint256,uint256,uint256,uint256,uint8) payable returns (uint256)",
  "function quotePrice(address) view returns (uint256)",
  "function setBrokerTreasury(address) external",
  "function brokerTreasury() view returns (address)",
  "function protocolTreasury() view returns (address)",
  "function brokerageFeeBps() view returns (uint16)",
  "function protocolFeeBps() view returns (uint16)",
  "function pendingETH(address) view returns (uint256)",
  "function nextOfferId() view returns (uint256)",
  "event BrokerageCollected(uint256 indexed offerId,address saleToken,uint256 sellerFee,uint256 buyerFee,uint256 protocolFee,address brokerTreasury,address protocolTreasury)",
  "event Purchased(uint256 indexed positionId,uint256 indexed offerId,address indexed buyer,uint256 saleAmount,uint256 collateralAmount,uint256 totalPayable,uint8 selectedInstallments)",
];
const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

const fmt18 = (n: bigint) => (Number(n)/1e18).toFixed(6);
const fmt6  = (n: bigint) => (Number(n)/1e6).toFixed(2);

async function main() {
  const [owner] = await ethers.getSigners();
  const provider = owner.provider!;
  const c        = new ethers.Contract(PROXY, ABI, owner);

  console.log("═══════════════════════════════════════════");
  console.log("  اختبار الرسوم — Protocol + Third-Party Broker");
  console.log("═══════════════════════════════════════════\n");

  // ── خطوة 1: عيّن Broker جديد (طرف ثالث) ──
  console.log("1️⃣  تعيين Broker جديد (طرف ثالث)...");
  const tx0 = await c.setBrokerTreasury(BROKER_THIRD_PARTY);
  await tx0.wait();
  console.log(`  ✅ brokerTreasury → ${BROKER_THIRD_PARTY.slice(0,10)}...`);
  const protAddr = await c.protocolTreasury();
  console.log(`  protocolTreasury (ثابت): ${protAddr.slice(0,10)}...`);
  console.log(`  → الرسوم ستنقسم الآن بين عنوانين مختلفين!\n`);

  // ── خطوة 2: إنشاء عرض ETH ──
  console.log("2️⃣  إنشاء عرض ETH للبيع...");
  const saleAmt  = ethers.parseEther("0.05");
  const ethPrice = await c.quotePrice(ethers.ZeroAddress);
  console.log(`  سعر ETH: $${(Number(ethPrice)/1e6).toFixed(0)}`);

  const offerId  = await c.nextOfferId();
  const tx1 = await c.createOffer(
    ethers.ZeroAddress, // saleToken = ETH
    ethers.ZeroAddress, // collateralToken = ETH
    USDC_ADDR,          // paymentToken = USDC
    0,                  // saleAmount (= 0 for ETH — يأتي من msg.value)
    1000,               // profitBps = 10%
    1, 2,               // min/max installments
    60,                 // paymentInterval = دقيقة
    0,                  // minPurchaseAmount
    11000,              // collateralRatioBps = 110%
    { value: saleAmt }
  );
  await tx1.wait();
  console.log(`  ✅ عرض #${offerId} — ${ethers.formatEther(saleAmt)} ETH @ 10% ربح\n`);

  // ── خطوة 3: مشتري يقبل العرض ──
  console.log("3️⃣  شراء العرض (المالك يمثّل المشتري للاختبار)...");
  const collateralNeeded = saleAmt * 11n * 110n / 1000n; // 110% تقريباً

  const tx2 = await c.buy(
    offerId,
    saleAmt,         // purchaseAmount
    0,               // collateralAmount (ETH via msg.value)
    ethPrice,        // quotedSalePrice
    2,               // selectedInstallments
    { value: collateralNeeded }
  );
  const receipt = await tx2.wait();
  console.log("  ✅ TX:", tx2.hash);

  // ── قراءة الأحداث ──
  console.log("\n4️⃣  تفاصيل الرسوم:\n");
  const iface = new ethers.Interface(ABI);
  let brokerFeeTotal = 0n, protFeeTotal = 0n, saleValue = 0n;

  for (const log of receipt!.logs) {
    try {
      const p = iface.parseLog({ topics:[...log.topics], data:log.data });
      if (!p) continue;
      if (p.name === "Purchased") {
        saleValue = p.args.saleAmount as bigint;
        console.log(`  📦 Purchased:`);
        console.log(`     مبلغ البيع:    ${fmt18(p.args.saleAmount as bigint)} ETH`);
        console.log(`     الضمان:        ${fmt18(p.args.collateralAmount as bigint)} ETH`);
        console.log(`     الإجمالي عليه: ${fmt6(p.args.totalPayable as bigint)} USDC`);
      }
      if (p.name === "BrokerageCollected") {
        const sF = p.args.sellerFee  as bigint;
        const bF = p.args.buyerFee   as bigint;
        const pF = p.args.protocolFee as bigint;
        brokerFeeTotal = sF + bF;
        protFeeTotal   = pF;
        const total    = sF + bF + pF;

        console.log(`\n  💰 BrokerageCollected:`);
        console.log(`  ┌─────────────────────────────────────────────`);
        console.log(`  │  من البائع   (+0.5%): ${fmt18(sF)} ETH  ($${(Number(sF)/1e18*Number(ethPrice)/1e6).toFixed(3)})`);
        console.log(`  │  من المشتري (+0.5%): ${fmt18(bF)} ETH  ($${(Number(bF)/1e18*Number(ethPrice)/1e6).toFixed(3)})`);
        console.log(`  │  ─────────────────────────────────────────`);
        console.log(`  │  🤝 Broker Treasury (الطرف الثالث):`);
        console.log(`  │     ${p.args.brokerTreasury}`);
        console.log(`  │     يستلم: ${fmt18(sF+bF)} ETH  ($${((Number(sF)+Number(bF))/1e18*Number(ethPrice)/1e6).toFixed(3)})`);
        console.log(`  │`);
        console.log(`  │  🏛️  Protocol Treasury:`);
        console.log(`  │     ${p.args.protocolTreasury}`);
        console.log(`  │     يستلم: ${fmt18(pF)} ETH  ($${(Number(pF)/1e18*Number(ethPrice)/1e6).toFixed(3)})`);
        console.log(`  │`);
        console.log(`  │  📊 الإجمالي: ${fmt18(total)} ETH  ($${(Number(total)/1e18*Number(ethPrice)/1e6).toFixed(3)})`);
        console.log(`  └─────────────────────────────────────────────`);
      }
    } catch {}
  }

  // ── رصيد Pending لكل خزينة ──
  console.log("\n5️⃣  رصيد Pending ETH بعد الصفقة:");
  const [pendBroker, pendProt] = await Promise.all([
    c.pendingETH(BROKER_THIRD_PARTY),
    c.pendingETH(protAddr),
  ]);
  console.log(`  🤝 Broker (طرف ثالث): ${fmt18(pendBroker)} ETH — جاهز للسحب`);
  console.log(`  🏛️  Protocol:          ${fmt18(pendProt)} ETH — جاهز للسحب`);

  // ── إعادة البروتوكول treasury للمالك ──
  console.log("\n6️⃣  إعادة brokerTreasury للمالك...");
  const txR = await c.setBrokerTreasury(owner.address);
  await txR.wait();
  console.log(`  ✅ brokerTreasury → ${owner.address.slice(0,10)}... (المالك)`);
}
main().catch(console.error);

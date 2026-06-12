import { ethers } from "ethers";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const RPC = "https://base-rpc.publicnode.com";

const ABI = [
  "function nextOfferId() view returns (uint256)",
  "function nextPositionId() view returns (uint256)",
  "function getOffer(uint256) view returns (tuple(address seller, address saleToken, address collateralToken, address paymentToken, uint256 totalAmount, uint256 saleAmount, uint256 minPurchaseAmount, uint16 profitBps, uint8 minInstallments, uint8 maxInstallments, uint32 paymentInterval, uint16 collateralRatioBps, uint8 state))",
  "function getPosition(uint256) view returns (tuple(uint256 offerId, address buyer, address saleToken, address collateralToken, address paymentToken, uint256 saleAmount, uint256 collateralAmount, uint256 totalPayable, uint8 totalInstallments, uint8 paidInstallments, uint32 paymentInterval, uint256 nextDueDate, uint8 state))",
  "function pendingETH(address) view returns (uint256)",
  "function owner() view returns (address)",
];

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const OFFER_STATES = ["ACTIVE", "CANCELLED"];
const POS_STATES = ["ACTIVE", "COMPLETED", "LIQUIDATED"];

async function main() {
  const p = new ethers.JsonRpcProvider(RPC);
  const c = new ethers.Contract(PROXY, ABI, p);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, p);
  const cbbtc = new ethers.Contract(CBBTC, ERC20_ABI, p);

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  🔍 جرد الأصول في عقد Qist على Base Mainnet              ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // 1. أرصدة العقد المباشرة
  const ethBal = await p.getBalance(PROXY);
  const usdcBal = await usdc.balanceOf(PROXY);
  const cbbtcBal = await cbbtc.balanceOf(PROXY);

  console.log("💰 أرصدة العقد المباشرة:");
  console.log(`   ETH:   ${ethers.formatEther(ethBal)}`);
  console.log(`   USDC:  ${ethers.formatUnits(usdcBal, 6)}`);
  console.log(`   cbBTC: ${ethers.formatUnits(cbbtcBal, 8)}`);

  // 2. العروض النشطة
  const nextOfferId = await c.nextOfferId();
  console.log(`\n📋 العروض (إجمالي: ${Number(nextOfferId) - 1} عرض):`);
  let activeOffersTotalETH = 0n;
  let activeOffersTotalCBBTC = 0n;
  let activeOffersCount = 0;
  for (let i = 1; i < Number(nextOfferId); i++) {
    try {
      const o = await c.getOffer(i);
      if (o.seller === ethers.ZeroAddress) continue;
      const stateText = OFFER_STATES[o.state] || "UNKNOWN";
      const tokenSym = o.saleToken === ethers.ZeroAddress ? "ETH" : (o.saleToken.toLowerCase() === CBBTC.toLowerCase() ? "cbBTC" : "?");
      const dec = o.saleToken === ethers.ZeroAddress ? 18 : 8;
      const amtStr = ethers.formatUnits(o.saleAmount, dec);

      if (o.state === 0n) {
        activeOffersCount++;
        if (o.saleToken === ethers.ZeroAddress) activeOffersTotalETH += o.saleAmount;
        else if (o.saleToken.toLowerCase() === CBBTC.toLowerCase()) activeOffersTotalCBBTC += o.saleAmount;
      }

      console.log(`   #${i}: ${stateText.padEnd(10)} | ${o.seller.slice(0,6)}...${o.seller.slice(-4)} | ${amtStr} ${tokenSym} متبقّي`);
    } catch {}
  }
  console.log(`\n   📊 ${activeOffersCount} عرض نشط محجوز فيها:`);
  console.log(`      ETH:   ${ethers.formatEther(activeOffersTotalETH)}`);
  console.log(`      cbBTC: ${ethers.formatUnits(activeOffersTotalCBBTC, 8)}`);

  // 3. المراكز النشطة
  const nextPosId = await c.nextPositionId();
  console.log(`\n📊 المراكز (إجمالي: ${Number(nextPosId) - 1} مركز):`);
  let lockedCollateralETH = 0n;
  let lockedCollateralCBBTC = 0n;
  let activePositions = 0;
  for (let i = 1; i < Number(nextPosId); i++) {
    try {
      const pos = await c.getPosition(i);
      if (pos.buyer === ethers.ZeroAddress) continue;
      const stateText = POS_STATES[pos.state] || "UNKNOWN";
      if (pos.state === 0n) {
        activePositions++;
        if (pos.collateralToken === ethers.ZeroAddress) lockedCollateralETH += pos.collateralAmount;
        else if (pos.collateralToken.toLowerCase() === CBBTC.toLowerCase()) lockedCollateralCBBTC += pos.collateralAmount;
      }
      console.log(`   #${i}: ${stateText.padEnd(11)} | ${pos.buyer.slice(0,6)}...${pos.buyer.slice(-4)} | ${pos.paidInstallments}/${pos.totalInstallments} قسط`);
    } catch {}
  }
  console.log(`\n   🔒 ${activePositions} مركز نشط مع ضمانات محجوزة:`);
  console.log(`      ETH:   ${ethers.formatEther(lockedCollateralETH)}`);
  console.log(`      cbBTC: ${ethers.formatUnits(lockedCollateralCBBTC, 8)}`);

  // 4. pendingETH للمستخدمين (المعلّق للسحب)
  const SELLER = "0x5e235cDCd43BCD3a3CB625cdC2c90fDAA443F117";
  const BUYER  = "0xBaA8CeF9f1CE60aed41D62ca12Fe490691697d74";
  const OWNER  = "0xef6F0C01C1f61a798923Baf57eb515f45d68c2e4";
  const pSeller = await c.pendingETH(SELLER);
  const pBuyer = await c.pendingETH(BUYER);
  const pOwner = await c.pendingETH(OWNER);

  console.log(`\n💎 ETH معلّقة للسحب (pendingETH):`);
  console.log(`   البائع  (0x5e23...F117): ${ethers.formatEther(pSeller)} ETH`);
  console.log(`   المشتري (0xBaA8...7d74): ${ethers.formatEther(pBuyer)} ETH`);
  console.log(`   المالك  (0xef6F...c2e4): ${ethers.formatEther(pOwner)} ETH`);
  const totalPending = pSeller + pBuyer + pOwner;
  console.log(`   ────────────────────────────────────`);
  console.log(`   المجموع المعلّق: ${ethers.formatEther(totalPending)} ETH`);

  // 5. ملخص شامل
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  📋 الملخص — تحقق من التوازن                            ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  const expectedETH = activeOffersTotalETH + lockedCollateralETH + totalPending;
  const expectedCBBTC = activeOffersTotalCBBTC + lockedCollateralCBBTC;

  console.log(`\nالأصول المتوقعة (عروض + ضمانات + معلّق):`);
  console.log(`   ETH:   ${ethers.formatEther(expectedETH)}`);
  console.log(`   cbBTC: ${ethers.formatUnits(expectedCBBTC, 8)}`);

  console.log(`\nالأصول الفعلية في العقد:`);
  console.log(`   ETH:   ${ethers.formatEther(ethBal)}`);
  console.log(`   cbBTC: ${ethers.formatUnits(cbbtcBal, 8)}`);
  console.log(`   USDC:  ${ethers.formatUnits(usdcBal, 6)} (يجب 0 — USDC يمر فقط)`);

  const ethDiff = ethBal - expectedETH;
  console.log(`\n🔍 الفرق (إذا = 0 ✅، إذا موجب = أصول إضافية):`);
  console.log(`   ETH: ${ethers.formatEther(ethDiff)} ${ethDiff === 0n ? "✅" : "⚠️"}`);
}
main();

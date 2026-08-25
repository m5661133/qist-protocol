import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Harness تكامل: يشغّل دورة حياة صفقة كاملة على الشبكة المحلية مع طباعة كل انتقال.
 * يحاكي التنسيق بين Base (هذا العقد) وBitcoin L1 (شهادات attestor).
 *
 *   npx hardhat run scripts/scenario-btc-escrow.ts
 */

const U = (n: number) => BigInt(Math.round(n * 1e6));
const SATS = (n: number) => BigInt(Math.round(n * 1e8));
const STATES = ["OPEN","AWAITING_COLLATERAL","AWAITING_DELIVERY","ACTIVE",
  "PAYMENT_OVERDUE","MARGIN_CALL","DEFAULT_PENDING","DISPUTED",
  "LIQUIDATION_ELIGIBLE","LIQUIDATED","REPAID","COLLATERAL_RELEASED","CANCELLED"];

const PK_SELLER = "0x02" + "11".repeat(32);
const PK_BUYER  = "0x03" + "22".repeat(32);
const BTC_ADDR  = "bc1qh2pz6t8crs7ykxh66emp2huxm5futgdsget5wd5jsuhnnug42nks2q3vsn";

const MERCH = SATS(0.16);   // البيتكوين المبيع
const COLLAT = SATS(0.5);   // الرهن المطلوب

const TERMS = {
  cost: U(10_000), profitBps: 1000, totalInstallments: 10, paymentInterval: 86400,
  marginCallLtvBps: 7500, liquidationLtvBps: 8500,
  merchandiseSats: MERCH, requiredCollateralSats: COLLAT,
};

async function show(m: any, id: number, label: string) {
  const d = await m.getDeal(id);
  const ltv = await m.previewHealth(id).then((r: any) => r.ltvBps).catch(() => "n/a");
  console.log(`  [${label}] state=${STATES[Number(d.state)]} · paid=${d.paidInstallments}/${d.totalInstallments} · collateral=${d.collateralSats} sats · ltv=${ltv}bps`);
}

async function main() {
  const [deployer, buyer, seller, attestor, arbiter, treasury] = await ethers.getSigners();

  console.log("\n🚀 نشر Mocks + العقد...");
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const btcFeed = await (await ethers.getContractFactory("MockFeed")).deploy(6_000_000_000_000n, 8); // $60k
  const seqFeed = await (await ethers.getContractFactory("MockSequencerFeed")).deploy(0, 1);

  const Factory = await ethers.getContractFactory("BtcEscrowMurabaha");
  const m: any = await upgrades.deployProxy(Factory, [
    deployer.address, await usdc.getAddress(), await btcFeed.getAddress(),
    await seqFeed.getAddress(), attestor.address, arbiter.address, treasury.address, 100,
  ], { kind: "uups", unsafeAllow: ["constructor"] });

  // المشتري وحده يحتاج USDC (يدفع الأقساط) — البائع يستلم
  await usdc.mint(buyer.address, U(1_000_000));
  await usdc.connect(buyer).approve(await m.getAddress(), ethers.MaxUint256);

  const DESC = ethers.id("2of3-descriptor");
  const DEP  = ethers.id("collateral-deposit-txid");
  const DEL  = ethers.id("merchandise-delivery-txid");

  console.log("\n─── دورة حياة بيع كاملة (٣ خطوات) ───");

  // الخطوة ١: البائع ينشر عرض بيع (يُنشر فوراً — لا خطوة نشر منفصلة)
  await m.connect(seller).createSellOffer(TERMS, PK_SELLER);
  await show(m, 1, "عرض بيع  ");

  // الخطوة ٢: المشتري يقبل (بمفتاحه وعنوان استلامه) ثم يودع الرهن على L1
  await m.connect(buyer).accept(1, PK_BUYER, BTC_ADDR);
  await show(m, 1, "قبول     ");
  console.log("  » المشتري يودع 0.5 BTC رهناً في خزنة 2-of-3...");
  await m.connect(attestor).confirmCollateral(1, COLLAT, DESC, DEP);
  await show(m, 1, "رهن محجوز");

  // الخطوة ٣: البائع يرسل المبيع مباشرة لعنوان المشتري (لا خزنة، لا توقيع منسّق)
  const before = await usdc.balanceOf(buyer.address);
  console.log(`  » البائع يرسل 0.16 BTC مباشرة إلى ${BTC_ADDR.slice(0, 16)}...`);
  await m.connect(attestor).confirmDelivery(1, MERCH, DEL);
  const after = await usdc.balanceOf(buyer.address);
  console.log(`  » قُبض المبيع. تغيّر USDC للمشتري: ${ethers.formatUnits(after - before, 6)} (صفر — بيع لا قرض)`);
  await show(m, 1, "تمّ البيع");

  // السداد: أقساط USDC من المشتري للبائع
  console.log("  » سداد 10 أقساط USDC...");
  for (let i = 0; i < 10; i++) {
    await m.connect(buyer).payInstallment(1);
    if (i < 9) await time.increase(86400);
  }
  await show(m, 1, "سُدّد    ");
  const sellerBal = await usdc.balanceOf(seller.address);
  const treas = await usdc.balanceOf(treasury.address);
  console.log(`  » البائع استلم ${ethers.formatUnits(sellerBal, 6)} USDC · الخزينة ${ethers.formatUnits(treas, 6)} USDC (رسوم)`);

  // فكّ الرهن للمشتري على L1 — بتوقيع البائع + المشتري، بلا قسط
  console.log("  » بناء PSBT فكّ الرهن (البائع + المشتري — بلا قسط) وبثّها...");
  await m.connect(attestor).confirmCollateralReleased(1, ethers.id("release-txid"));
  await show(m, 1, "فُكّ الرهن");

  console.log("\n✅ الدورة السعيدة اكتملت. العقد لم يحتجز USDC:",
    (await usdc.balanceOf(await m.getAddress())).toString());
  console.log("   معاملات Bitcoin: ٣ (إيداع الرهن · تسليم المبيع · فكّ الرهن)\n");

  // ─── سيناريو ثانٍ: طلب شراء ينتهي بتصفية سعرية ───
  console.log("─── سيناريو طلب شراء + تصفية سعرية ───");
  await m.connect(buyer).createBuyRequest(TERMS, PK_BUYER, BTC_ADDR);
  await show(m, 2, "طلب شراء ");
  await m.connect(seller).accept(2, PK_SELLER, "");
  await m.connect(attestor).confirmCollateral(2, COLLAT, DESC, ethers.id("dep2"));
  await m.connect(attestor).confirmDelivery(2, MERCH, ethers.id("del2"));
  await show(m, 2, "نشط     ");
  console.log("  » سعر BTC ينهار $60k → $24k...");
  await btcFeed.setAnswer(2_400_000_000_000n);
  await m.poke(2);
  await show(m, 2, "poke     ");
  console.log("  » تصفية جزئية: الدين للبائع، الفائض للمشتري (على L1)...");
  await m.connect(attestor).confirmLiquidation(2, U(11_000), SATS(0.45), SATS(0.05), ethers.id("liq"));
  await show(m, 2, "مُصفّاة  ");

  console.log("\n✅ Harness التكامل نجح — الاتجاهان يعملان.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });

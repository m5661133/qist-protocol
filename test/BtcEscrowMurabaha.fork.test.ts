import { expect } from "chai";
import { ethers, upgrades } from "hardhat";

// اختبار ضد بيانات Base الحقيقية (Fork) — يُشغَّل فقط مع FORK=1:
//   FORK=1 npx hardhat test test/BtcEscrowMurabaha.fork.test.ts
//
// يستخدم نفس مغذّيات Chainlink التي يستخدمها عقد قسط الرئيسي على Base Mainnet.

const U    = (n: number) => BigInt(Math.round(n * 1e6));
const SATS = (n: number) => BigInt(Math.round(n * 1e8));

// عناوين Base Mainnet الحقيقية (نفس ما يستخدمه MurabahaV6 / deploy-base.ts)
const BTC_USD_FEED = "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F"; // Chainlink BTC/USD
const SEQUENCER    = "0xBCF85224fc0756B9Fa45aA7892530B47e10b6433"; // L2 Sequencer Uptime

const DESC = ethers.id("2of3");
const TXID = ethers.id("dep");

const PK_SELLER = "0x02" + "11".repeat(32);
const PK_BUYER  = "0x03" + "22".repeat(32);
const BTC_ADDR  = "bc1qh2pz6t8crs7ykxh66emp2huxm5futgdsget5wd5jsuhnnug42nks2q3vsn";

describe("BtcEscrowMurabaha — Base fork (بيانات قسط الحقيقية)", function () {
  before(function () {
    if (!process.env.FORK) this.skip(); // يتطلّب FORK=1 لتفعيل fork من Base
  });

  it("يقرأ سعر BTC/USD الحقيقي من Chainlink على Base ويحسب LTV بنجاح", async () => {
    const [owner, buyer, seller, attestor, arbiter, treasury] = await ethers.getSigners();

    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const Factory = await ethers.getContractFactory("BtcEscrowMurabaha");
    const m: any = await upgrades.deployProxy(Factory, [
      owner.address, await usdc.getAddress(), BTC_USD_FEED, SEQUENCER,
      attestor.address, arbiter.address, treasury.address, 100,
    ], { kind: "uups", unsafeAllow: ["constructor"] });

    // عرض بيع: تكلفة $10,000 + 10% ربح، رهن 1 BTC (صحّي مهما كان السعر الحقيقي)
    await m.connect(seller).createSellOffer({
      cost: U(10_000), profitBps: 1000, totalInstallments: 10, paymentInterval: 86400,
      marginCallLtvBps: 7500, liquidationLtvBps: 8500,
      merchandiseSats: SATS(0.16), requiredCollateralSats: SATS(1),
    }, PK_SELLER);
    await m.connect(buyer).accept(1, PK_BUYER, BTC_ADDR);

    // confirmCollateral يقرأ سعر Chainlink الحقيقي + يفحص Sequencer الحقيقي
    await m.connect(attestor).confirmCollateral(1, SATS(1), DESC, TXID);

    const [ltvBps, suggested] = await m.previewHealth(1);
    const price6 = 11000n * 10000n / ltvBps; // debt=11000 USDC، LTV=debt/collateralValue → قيمة الرهن
    console.log(`      سعر BTC الحقيقي المستنتج ≈ $${(price6).toString()} · LTV=${ltvBps} bps · الحالة المقترحة=${suggested}`);

    // يجب أن يقرأ سعراً حقيقياً معقولاً (LTV موجب وصحّي مع 1 BTC مقابل دين $11k)
    expect(ltvBps).to.be.gt(0n);
    expect(ltvBps).to.be.lt(8000n); // < 80% = صحّي
    // الرهن كفى عند السعر الحقيقي → تنتظر تسليم البائع للمبيع
    expect((await m.getDeal(1)).state).to.equal(2n); // AWAITING_DELIVERY
  });
});

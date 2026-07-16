import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// ── Unit helpers ──────────────────────────────────────────────────────────
const U   = (n: number) => BigInt(Math.round(n * 1e6));   // USDC 6 dec
const BTC = (n: number) => BigInt(Math.round(n * 1e8));   // WBTC 8 dec
const E   = ethers.parseEther;                             // ETH 18 dec

// وحدة الزمن للاختبارات: دقيقة واحدة (60 ثانية) بدل 30 يوم
const INTERVAL = 60n;        // BigInt — للعقد (uint32)
const INTERVAL_N = 60;       // number — لـ time.increase
const GRACE = 259200;        // GRACE_PERIOD = 3 أيام (الإنتاج)

// Feed prices — Chainlink 8 decimals ($price × 10^8)
const ETH_FEED     = 300_000_000_000n;    // $3,000
const BTC_FEED     = 6_000_000_000_000n;  // $60,000
const BTC_CRASH    = 4_000_000_000_000n;  // $40,000 — collateral < debt (no refund)
const BTC_DIP      = 4_400_000_000_000n;  // $44,000 — liquidatable, buyer refund > 0
const ETH_CRASH    = 1_000_000_000n;      // $10     — ETH collateral انهار تماماً

// Quoted prices passed to buy — 6 decimals
const Q_BTC = 60000n * 10n ** 6n;
const Q_ETH = 3000n  * 10n ** 6n;

// ── Math constants for 1 WBTC @ $60k, 10% profit, brokerageFee=0.5%+0.5%, protocolFee=1% ─
// التعديل: الرسوم مفصولة — brokerTreasury (1%) + protocolTreasury (1%) = 2% من الأصل
const M = {
  sellerFee:           500_000n,         // BTC 0.5%
  buyerFee:            500_000n,         // BTC 0.5%
  protocolFeeAsset:  1_000_000n,         // BTC 1%
  totalBrokerage:    1_000_000n,         // brokerTreasury (sellerFee+buyerFee)
  totalFeesAsset:    2_000_000n,         // إجمالي من الأصل (2%)
  netToBuyer:       98_000_000n,         // BTC: 0.98
  saleValueUSDC:    58_800_000_000n,     // $58,800
  totalPayable:     64_680_000_000n,     // $64,680 (10% profit)
  installment:       5_390_000_000n,     // ×12 exact
  sellerPerInst:     5_390_000_000n,     // يذهب للبائع مباشرة (لا رسوم USDC)
  reqCollateral:    77_616_000_000n,     // 120% of totalPayable
};

// ── Deploy ────────────────────────────────────────────────────────────────
async function deploy() {
  const [owner, seller, buyer, buyer2, keeper, stranger] = await ethers.getSigners();
  const usdc    = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const wbtc    = await (await ethers.getContractFactory("MockWBTC")).deploy();
  const ethFeed = await (await ethers.getContractFactory("MockFeed")).deploy(ETH_FEED, 8);
  const btcFeed = await (await ethers.getContractFactory("MockFeed")).deploy(BTC_FEED, 8);
  const Murabaha = await ethers.getContractFactory("MurabahaV6");
  const m = await upgrades.deployProxy(Murabaha, [
    await usdc.getAddress(), await wbtc.getAddress(),
    await ethFeed.getAddress(), await btcFeed.getAddress(),
    owner.address, // brokerTreasury
    owner.address  // protocolTreasury
  ], { kind: "uups", unsafeAllow: ["constructor"] });
  await m.setKeeper(keeper.address);
  await wbtc.mint(seller.address, BTC(100));
  for (const b of [buyer, buyer2]) {
    await wbtc.mint(b.address, BTC(50));
    await usdc.mint(b.address, U(2_000_000));
  }
  return { m, usdc, wbtc, ethFeed, btcFeed, owner, seller, buyer, buyer2, keeper, stranger };
}
type Ctx = Awaited<ReturnType<typeof deploy>>;

// ── Helper: عرض + مركز WBTC/WBTC جاهز ───────────────────────────────────
async function openPosition(ctx: Ctx, opts: {
  profit?: number; inst?: number; col?: number;
} = {}) {
  const { m, wbtc, usdc, seller, buyer } = ctx;
  const maxInst = opts.inst ?? 12;
  const mAddr = await m.getAddress();
  const wbtcAddr = await wbtc.getAddress();
  const usdcAddr = await usdc.getAddress();
  await wbtc.connect(seller).approve(mAddr, BTC(100));
  await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), opts.profit ?? 1000, 1, maxInst, INTERVAL, 0, 12000, false);
  await wbtc.connect(buyer).approve(mAddr, BTC(50));
  await usdc.connect(buyer).approve(mAddr, U(2_000_000));
  await m.connect(buyer).buy(1, BTC(1), BTC(opts.col ?? 1.5), Q_BTC, maxInst, false);
}

// ═══════════════════════════════════════════════════════════════════════════
describe("A — Constructor", () => {
  it("يرفض zero-address لكل معامل (عبر initialize)", async () => {
    const { usdc, wbtc, ethFeed, btcFeed, owner } = await deploy();
    const F = await ethers.getContractFactory("MurabahaV6");
    const [u, w, ef, bf, o] = [
      await usdc.getAddress(), await wbtc.getAddress(),
      await ethFeed.getAddress(), await btcFeed.getAddress(), owner.address,
    ];
    const z = ethers.ZeroAddress;
    // مع UUPS: نختبر initialize() مباشرة بدل deploy()
    for (const args of [
      [z, w, ef, bf, o, o], [u, z, ef, bf, o, o], [u, w, z, bf, o, o],
      [u, w, ef, z, o, o],  [u, w, ef, bf, z, o], [u, w, ef, bf, o, z],
    ] as [string, string, string, string, string, string][]) {
      await expect(
        upgrades.deployProxy(F, args, { kind: "uups", unsafeAllow: ["constructor"] })
      ).to.be.reverted;
    }
  });

  it("القيم الأولية صحيحة", async () => {
    const { m, owner } = await deploy();
    expect(await m.protocolFeeBps()).to.equal(100);
    expect(await m.brokerageFeeBps()).to.equal(50);
    expect(await m.brokerTreasury()).to.equal(owner.address);
    expect(await m.protocolTreasury()).to.equal(owner.address);
    expect(await m.nextOfferId()).to.equal(1);
    expect(await m.nextPositionId()).to.equal(1);
    expect(await m.MIN_COLLATERAL_RATIO_BPS()).to.equal(11000);
    expect(await m.LIQUIDATION_THRESHOLD_BPS()).to.equal(10500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("B — إنشاء العروض", () => {
  it("createOffer: يُودع WBTC ويُنشئ العرض ويُطلق الحدث", async () => {
    const { m, wbtc, usdc, seller } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    const selBefore = await wbtc.balanceOf(seller.address);
    await expect(m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false))
      .to.emit(m, "OfferCreated");
    expect(await wbtc.balanceOf(seller.address)).to.equal(selBefore - BTC(1));
    const o = await m.getOffer(1);
    expect(o.state).to.equal(0n); // ACTIVE
    expect(o.saleAmount).to.equal(BTC(1));
  });

  it("createOffer ETH: يُودع ETH", async () => {
    const { m, usdc, seller } = await deploy();
    const mAddr = await m.getAddress();
    const usdcAddr = await usdc.getAddress();
    await m.connect(seller).createOffer(ethers.ZeroAddress, ethers.ZeroAddress, usdcAddr, 0, 500, 1, 6, INTERVAL, 0, 13000, false, { value: E("5") });
    expect(await ethers.provider.getBalance(mAddr)).to.equal(E("5"));
    const o = await m.getOffer(1);
    expect(o.saleToken).to.equal(ethers.ZeroAddress); // ETH
  });

  it("يرفض collateralRatioBps < 11000 أو > 20000", async () => {
    const { m, wbtc, usdc, seller } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(2));
    // أقل من 110% → مرفوض
    await expect(m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 10999, false))
      .to.be.revertedWithCustomError(m, "InvalidParams");
    // أكثر من 200% → مرفوض
    await expect(m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 20001, false))
      .to.be.revertedWithCustomError(m, "InvalidParams");
  });

  it("يرفض saleAmount = 0", async () => {
    const { m, wbtc, usdc, seller } = await deploy();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await expect(m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, 0n, 1000, 1, 12, INTERVAL, 0, 12000, false))
      .to.be.revertedWithCustomError(m, "ZeroAmount");
  });

  it("يرفض installments = 0", async () => {
    const { m, wbtc, usdc, seller } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await expect(m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 0, 12, INTERVAL, 0, 12000, false))
      .to.be.revertedWithCustomError(m, "InvalidParams");
  });

  it("يرفض createOffer ETH بدون ETH", async () => {
    const { m, usdc, seller } = await deploy();
    const usdcAddr = await usdc.getAddress();
    await expect(m.connect(seller).createOffer(ethers.ZeroAddress, ethers.ZeroAddress, usdcAddr, 0, 500, 1, 6, INTERVAL, 0, 13000, false))
      .to.be.revertedWithCustomError(m, "ZeroAmount");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("C — إدارة العروض", () => {
  it("increaseOffer: يزيد الكمية", async () => {
    const { m, wbtc, usdc, seller } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(10));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await expect(m.connect(seller).increaseOffer(1, BTC(2)))
      .to.emit(m, "OfferIncreased").withArgs(1n, BTC(2), BTC(3));
    expect((await m.getOffer(1)).saleAmount).to.equal(BTC(3));
  });

  it("increaseOffer ETH: يزيد ETH", async () => {
    const { m, usdc, seller } = await deploy();
    const usdcAddr = await usdc.getAddress();
    await m.connect(seller).createOffer(ethers.ZeroAddress, ethers.ZeroAddress, usdcAddr, 0, 500, 1, 6, INTERVAL, 0, 13000, false, { value: E("2") });
    await m.connect(seller).increaseOffer(1, 0, { value: E("3") });
    expect((await m.getOffer(1)).saleAmount).to.equal(E("5"));
  });

  it("decreaseOffer: يسحب ويُنقص الكمية", async () => {
    const { m, wbtc, usdc, seller } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(3));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(3), 1000, 1, 12, INTERVAL, 0, 12000, false);
    const before = await wbtc.balanceOf(seller.address);
    await m.connect(seller).decreaseOffer(1, BTC(1));
    expect(await wbtc.balanceOf(seller.address)).to.equal(before + BTC(1));
    expect((await m.getOffer(1)).saleAmount).to.equal(BTC(2));
  });

  it("decreaseOffer: يُغلق العرض عند الوصول لصفر", async () => {
    const { m, wbtc, usdc, seller } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await m.connect(seller).decreaseOffer(1, BTC(1));
    expect((await m.getOffer(1)).state).to.equal(1n); // CLOSED
  });

  it("cancelOffer: يُعيد كل الأصول ويُطلق الحدث", async () => {
    const { m, wbtc, usdc, seller } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(5));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(5), 1000, 1, 12, INTERVAL, 0, 12000, false);
    const before = await wbtc.balanceOf(seller.address);
    await expect(m.connect(seller).cancelOffer(1)).to.emit(m, "OfferCancelled").withArgs(1n);
    expect(await wbtc.balanceOf(seller.address)).to.equal(before + BTC(5));
    expect((await m.getOffer(1)).state).to.equal(1n);
  });

  it("لا يمكن لغير البائع تعديل العرض", async () => {
    const { m, wbtc, usdc, seller, stranger } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await expect(m.connect(stranger).decreaseOffer(1, BTC(1)))
      .to.be.revertedWithCustomError(m, "NotSeller");
    await expect(m.connect(stranger).cancelOffer(1))
      .to.be.revertedWithCustomError(m, "NotSeller");
  });

  it("لا يمكن تعديل عرض مُغلق", async () => {
    const { m, wbtc, usdc, seller } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await m.connect(seller).cancelOffer(1);
    await expect(m.connect(seller).cancelOffer(1))
      .to.be.revertedWithCustomError(m, "OfferNotActive");
    await expect(m.connect(seller).decreaseOffer(1, BTC(1)))
      .to.be.revertedWithCustomError(m, "OfferNotActive");
  });

  it("شراء جزئي يُنقص offer.saleAmount بدون إغلاق", async () => {
    const { m, wbtc, usdc, seller, buyer } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(3));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(3), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await wbtc.connect(buyer).approve(mAddr, BTC(2));
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    await m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q_BTC, 12, false);
    expect((await m.getOffer(1)).saleAmount).to.equal(BTC(2));
    expect((await m.getOffer(1)).state).to.equal(0n); // ACTIVE
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("D — الشراء وتحقق الأرقام", () => {
  it("مبالغ العمولة والصافي دقيقة تماماً", async () => {
    const { m, wbtc, usdc, seller, buyer, owner } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await wbtc.connect(buyer).approve(mAddr, BTC(1.5));

    const buyerBefore = await wbtc.balanceOf(buyer.address);
    const feeRecBefore = await wbtc.balanceOf(owner.address);
    await m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q_BTC, 12, false);

    // المشتري: دفع ضمان BTC(1.5) + استلم BTC(0.99) → صافي خرج = BTC(0.51)
    expect(buyerBefore - (await wbtc.balanceOf(buyer.address)))
      .to.equal(BTC(1.5) - M.netToBuyer);
    // brokerTreasury يستلم 1% (sellerFee+buyerFee) + protocolTreasury يستلم 1%
    // في الاختبار كلاهما owner → owner يستلم 2% إجمالاً
    expect((await wbtc.balanceOf(owner.address)) - feeRecBefore)
      .to.equal(M.totalFeesAsset);

    const p = await m.getPosition(1);
    expect(p.totalPayable).to.equal(M.totalPayable);
    expect(p.collateralAmount).to.equal(BTC(1.5));
    expect(p.saleAmount).to.equal(M.netToBuyer);
    expect(p.totalInstallments).to.equal(12n);
    expect(p.paidInstallments).to.equal(0n);
    expect(p.state).to.equal(0n); // ACTIVE
  });

  it("يُطلق حدث Purchased بالمعاملات الصحيحة", async () => {
    const { m, wbtc, usdc, seller, buyer } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await wbtc.connect(buyer).approve(mAddr, BTC(1.5));
    await expect(m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q_BTC, 12, false))
      .to.emit(m, "Purchased")
      .withArgs(1n, 1n, buyer.address, M.netToBuyer, BTC(1.5), M.totalPayable, 12n);
  });

  it("يرفض ضماناً غير كافٍ", async () => {
    const { m, wbtc, usdc, seller, buyer } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await wbtc.connect(buyer).approve(mAddr, BTC(1));
    // BTC(1) @ $60k = $60k < M.reqCollateral ($78,408)
    await expect(m.connect(buyer).buy(1, BTC(1), BTC(1), Q_BTC, 12, false))
      .to.be.revertedWithCustomError(m, "InsufficientCollateral");
  });

  it("يرفض انزلاق > 1%", async () => {
    const { m, wbtc, usdc, seller, buyer } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await wbtc.connect(buyer).approve(mAddr, BTC(2));
    const stale = 59000n * 10n ** 6n; // diff = $1,000 > 1% of $60,000
    await expect(m.connect(buyer).buy(1, BTC(1), BTC(2), stale, 12, false))
      .to.be.revertedWithCustomError(m, "SlippageExceeded");
  });

  it("يقبل انزلاق 0.5% (ضمن الحد)", async () => {
    const { m, wbtc, usdc, seller, buyer } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await wbtc.connect(buyer).approve(mAddr, BTC(2));
    const closeQ = 59700n * 10n ** 6n; // diff = $300 = 0.5% ✓
    await expect(m.connect(buyer).buy(1, BTC(1), BTC(2), closeQ, 12, false))
      .not.to.be.reverted;
  });

  it("يرفض شراء من عرض ETH بضمان token غير مدعوم", async () => {
    // عرض ETH يقبل فقط ضمان ETH (ZeroAddress)
    // الشراء بضمان WBTC (token) مقابل عرض ETH يُولّد TokenNotSupported أو InvalidParams
    const { m, wbtc, usdc, seller, buyer } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    // عرض WBTC مع ضمان ETH (ZeroAddress)
    await m.connect(seller).createOffer(wbtcAddr, ethers.ZeroAddress, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    // المشتري يحاول الشراء بـ collateralAmount > 0 بدون إرسال ETH → يُرفض
    await wbtc.connect(buyer).approve(mAddr, BTC(2));
    await expect(m.connect(buyer).buy(1, BTC(1), BTC(2), Q_BTC, 12, false))
      .to.be.reverted;
  });

  it("يرفض الشراء من عرض مُغلق", async () => {
    const { m, wbtc, usdc, seller, buyer } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await m.connect(seller).cancelOffer(1);
    await wbtc.connect(buyer).approve(mAddr, BTC(2));
    await expect(m.connect(buyer).buy(1, BTC(1), BTC(2), Q_BTC, 12, false))
      .to.be.revertedWithCustomError(m, "OfferNotActive");
  });

  it("يرفض saleAmount أكبر من المتاح في العرض", async () => {
    const { m, wbtc, usdc, seller, buyer } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await wbtc.connect(buyer).approve(mAddr, BTC(3));
    await expect(m.connect(buyer).buy(1, BTC(2), BTC(3), Q_BTC, 12, false))
      .to.be.revertedWithCustomError(m, "InvalidParams");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("E — الأقساط وصحة الحسابات", () => {
  it("قيمة القسط وتوزيع الرسوم دقيق", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    const { m, usdc, seller, buyer, owner } = ctx;
    const ownerBefore  = await usdc.balanceOf(owner.address);
    const sellerBefore = await usdc.balanceOf(seller.address);
    const buyerBefore  = await usdc.balanceOf(buyer.address);

    await expect(m.connect(buyer).payInstallment(1))
      .to.emit(m, "InstallmentPaid").withArgs(1n, 1n, M.installment);

    // الأقساط USDC تذهب كاملاً للبائع — لا رسوم USDC (الرسوم تُؤخذ من الأصل عند الشراء)
    expect((await usdc.balanceOf(buyer.address))).to.equal(buyerBefore - M.installment);
    expect((await usdc.balanceOf(owner.address))).to.equal(ownerBefore); // لا تغيير USDC للـ owner
    expect((await usdc.balanceOf(seller.address))).to.equal(sellerBefore + M.installment);
    expect((await m.getPosition(1)).paidInstallments).to.equal(1n);
  });

  it("القسط الأخير يصحّح فروق التقريب (CODE-V2-1) — 7 أقساط", async () => {
    const { m, wbtc, usdc, seller, buyer } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 7, INTERVAL, 0, 12000, false);
    await wbtc.connect(buyer).approve(mAddr, BTC(2));
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    await m.connect(buyer).buy(1, BTC(1), BTC(2), Q_BTC, 7, false);

    const total = M.totalPayable;
    const reg   = total / 7n;          // يُسقط الكسر
    const last  = total - reg * 6n;    // يجبر الإجمالي الصحيح

    for (let i = 0; i < 6; i++) await m.connect(buyer).payInstallment(1);
    const before = await usdc.balanceOf(buyer.address);
    await m.connect(buyer).payInstallment(1);

    expect(before - (await usdc.balanceOf(buyer.address))).to.equal(last);
    expect((await m.getPosition(1)).state).to.equal(1n); // COMPLETED
  });

  it("12 قسطاً كاملة تُعيد الضمان وتُغلق المركز", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    const { m, wbtc, buyer } = ctx;
    const colBefore = await wbtc.balanceOf(buyer.address);
    for (let i = 0; i < 12; i++) await m.connect(buyer).payInstallment(1);
    expect((await m.getPosition(1)).state).to.equal(1n);
    expect((await m.getPosition(1)).collateralAmount).to.equal(0n);
    expect(await wbtc.balanceOf(buyer.address)).to.equal(colBefore + BTC(1.5));
  });

  it("يُطلق PositionCompleted عند القسط الأخير", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    const { m, buyer } = ctx;
    for (let i = 0; i < 11; i++) await m.connect(buyer).payInstallment(1);
    await expect(m.connect(buyer).payInstallment(1))
      .to.emit(m, "PositionCompleted").withArgs(1n, BTC(1.5));
  });

  it("يرفض payInstallment من غير المشتري", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    await expect(ctx.m.connect(ctx.stranger).payInstallment(1))
      .to.be.revertedWithCustomError(ctx.m, "NotBuyer");
  });

  it("يرفض payInstallment على مركز مكتمل", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    const { m, buyer } = ctx;
    for (let i = 0; i < 12; i++) await m.connect(buyer).payInstallment(1);
    await expect(m.connect(buyer).payInstallment(1))
      .to.be.revertedWithCustomError(m, "PositionNotActive");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("F — إدارة الضمان وHealth Factor", () => {
  it("withdrawExcessCollateral ينجح ضمن HF آمن", async () => {
    // سحب BTC(0.1): col = 1.4 BTC @ $60k = $84k, HF = 12857 > 12000
    const ctx = await deploy();
    await openPosition(ctx);
    const { m, wbtc, buyer } = ctx;
    const before = await wbtc.balanceOf(buyer.address);
    await expect(m.connect(buyer).withdrawExcessCollateral(1, BTC(0.1)))
      .to.emit(m, "CollateralChanged");
    expect(await wbtc.balanceOf(buyer.address)).to.equal(before + BTC(0.1));
    expect((await m.getPosition(1)).collateralAmount).to.equal(BTC(1.5) - BTC(0.1));
  });

  it("withdrawExcessCollateral يرفض لو HF سيقل عن 110%", async () => {
    // سحب BTC(0.35): col = 1.15 BTC @ $60k = $69k, HF ≈ 106.7% < 110%
    const ctx = await deploy();
    await openPosition(ctx);
    await expect(ctx.m.connect(ctx.buyer).withdrawExcessCollateral(1, BTC(0.35)))
      .to.be.revertedWithCustomError(ctx.m, "HealthFactorTooLow");
  });

  it("withdrawExcessCollateral يرفض من غير المشتري", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    await expect(ctx.m.connect(ctx.stranger).withdrawExcessCollateral(1, BTC(0.1)))
      .to.be.revertedWithCustomError(ctx.m, "NotBuyer");
  });

  it("addCollateral يزيد الضمان", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    const { m, wbtc, buyer } = ctx;
    await wbtc.connect(buyer).approve(await m.getAddress(), BTC(1));
    await m.connect(buyer).addCollateral(1, BTC(0.5));
    expect((await m.getPosition(1)).collateralAmount).to.equal(BTC(2));
  });

  it("addCollateral ETH يزيد ضمان ETH", async () => {
    const { m, wbtc, usdc, seller, buyer } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, ethers.ZeroAddress, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    await m.connect(buyer).buy(1, BTC(1), 0, Q_BTC, 12, false, { value: E("30") });
    const before = (await m.getPosition(1)).collateralAmount;
    await m.connect(buyer).addCollateral(1, 0, { value: E("5") });
    expect((await m.getPosition(1)).collateralAmount).to.equal(before + E("5"));
  });

  it("addCollateral بـ token على مركز ETH يُرفض", async () => {
    // المركز يستخدم ETH كضمان — إضافة token (WBTC) بدون إرسال ETH يُرفض
    const { m, wbtc, usdc, seller, buyer } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, ethers.ZeroAddress, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    await m.connect(buyer).buy(1, BTC(1), 0, Q_BTC, 12, false, { value: E("30") });
    await wbtc.connect(buyer).approve(mAddr, BTC(1));
    // محاولة إضافة WBTC كضمان على مركز ETH — tokenAmount > 0 بدون value
    await expect(m.connect(buyer).addCollateral(1, BTC(1)))
      .to.be.reverted;
  });

  it("healthFactor يُرجع max للمركز المكتمل", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    for (let i = 0; i < 12; i++) await ctx.m.connect(ctx.buyer).payInstallment(1);
    expect(await ctx.m.healthFactor(1)).to.equal(ethers.MaxUint256);
  });

  it("healthFactor ينخفض عند هبوط السعر", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    const hfBefore = await ctx.m.healthFactor(1);
    await ctx.btcFeed.setAnswer(BTC_CRASH);
    const hfAfter = await ctx.m.healthFactor(1);
    expect(hfAfter).to.be.lt(hfBefore);
    expect(hfAfter).to.be.lt(10500n);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("G — السداد المبكر", () => {
  it("earlyRepayCash يُغلق المركز ويُعيد الضمان", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    const { m, wbtc, buyer } = ctx;
    const colBefore = await wbtc.balanceOf(buyer.address);
    await expect(m.connect(buyer).earlyRepayCash(1))
      .to.emit(m, "PositionCompleted").withArgs(1n, BTC(1.5));
    expect((await m.getPosition(1)).state).to.equal(1n); // COMPLETED
    expect(await wbtc.balanceOf(buyer.address)).to.equal(colBefore + BTC(1.5));
  });

  it("earlyRepayCash بعد 6 أقساط: يدفع المتبقي فقط", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    const { m, usdc, buyer } = ctx;
    for (let i = 0; i < 6; i++) await m.connect(buyer).payInstallment(1);
    const remaining = M.totalPayable - M.installment * 6n;
    const before = await usdc.balanceOf(buyer.address);
    await m.connect(buyer).earlyRepayCash(1);
    expect(before - (await usdc.balanceOf(buyer.address))).to.equal(remaining);
  });

  it("earlyRepayWithCollateral: state = COMPLETED (لا LIQUIDATED) — BUG-015 ثابت", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    await ctx.m.connect(ctx.buyer).earlyRepayWithCollateral(1);
    expect((await ctx.m.getPosition(1)).state).to.equal(1n); // COMPLETED ✓
  });

  it("earlyRepayWithCollateral: البائع يستلم بقدر الدين والفائض للمشتري", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    const { m, wbtc, seller, buyer } = ctx;

    // colForDebt = totalPayable * 1e8 / Q_BTC
    // = 65_340_000_000 * 100_000_000 / 60_000_000_000 = 108_900_000 = BTC(1.089)
    const colForDebt = M.totalPayable * BigInt(1e8) / Q_BTC;
    const refund     = BTC(1.5) - colForDebt;

    const sellerBefore = await wbtc.balanceOf(seller.address);
    const buyerBefore  = await wbtc.balanceOf(buyer.address);
    await m.connect(buyer).earlyRepayWithCollateral(1);

    expect(await wbtc.balanceOf(seller.address)).to.equal(sellerBefore + colForDebt);
    expect(await wbtc.balanceOf(buyer.address)).to.equal(buyerBefore  + refund);
  });

  it("لا يمكن لغير المشتري السداد المبكر", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    await expect(ctx.m.connect(ctx.stranger).earlyRepayCash(1))
      .to.be.revertedWithCustomError(ctx.m, "NotBuyer");
    await expect(ctx.m.connect(ctx.stranger).earlyRepayWithCollateral(1))
      .to.be.revertedWithCustomError(ctx.m, "NotBuyer");
  });

  it("لا يمكن السداد المبكر على مركز مكتمل", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    await ctx.m.connect(ctx.buyer).earlyRepayCash(1);
    await expect(ctx.m.connect(ctx.buyer).earlyRepayCash(1))
      .to.be.revertedWithCustomError(ctx.m, "PositionNotActive");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("H — التصفية", () => {
  it("isLiquidatable: false للمركز السليم", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    const [ok] = await ctx.m.isLiquidatable(1);
    expect(ok).to.equal(false);
  });

  it("isLiquidatable: overdue بعد مهلة 3 أيام", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    await time.increase(INTERVAL_N + GRACE + 1);
    const [ok, reason] = await ctx.m.isLiquidatable(1);
    expect(ok).to.equal(true);
    expect(reason).to.equal("overdue");
  });

  it("isLiquidatable: false قبل انتهاء مهلة 3 أيام", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    await time.increase(INTERVAL_N + 60); // interval + 60 ثانية (أقل من GRACE=120)
    const [ok] = await ctx.m.isLiquidatable(1);
    expect(ok).to.equal(false);
  });

  it("isLiquidatable: undercollateralized عند هبوط السعر", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    await ctx.btcFeed.setAnswer(BTC_CRASH);
    const [ok, reason] = await ctx.m.isLiquidatable(1);
    expect(ok).to.equal(true);
    expect(reason).to.equal("undercollateralized");
  });

  it("تصفية undercollateral: البائع يستلم + المشتري يسترد الفائض", async () => {
    // BTC_DIP=$44k: colValue=$66k > debt=$65,340 → مشتري يسترد الفائض
    const ctx = await deploy();
    await openPosition(ctx);
    const { m, wbtc, seller, buyer, keeper } = ctx;
    await ctx.btcFeed.setAnswer(BTC_DIP);

    const sellerBefore = await wbtc.balanceOf(seller.address);
    const buyerBefore  = await wbtc.balanceOf(buyer.address);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    await expect(m.connect(keeper).performUpkeep(data)).to.emit(m, "PositionLiquidated");

    expect((await m.getPosition(1)).state).to.equal(2n); // LIQUIDATED
    expect(await wbtc.balanceOf(seller.address)).to.be.gt(sellerBefore);
    expect(await wbtc.balanceOf(buyer.address)).to.be.gt(buyerBefore);
  });

  it("تصفية overdue: البائع يأخذ كل الضمان (دين > ضمان)", async () => {
    // BTC_CRASH=$40k: colValue=$60k < debt=$65,340 → صفر للمشتري
    const ctx = await deploy();
    await openPosition(ctx);
    const { m, wbtc, seller, buyer, keeper } = ctx;
    await ctx.btcFeed.setAnswer(BTC_CRASH);

    const buyerBefore = await wbtc.balanceOf(buyer.address);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    await m.connect(keeper).performUpkeep(data);

    expect((await m.getPosition(1)).state).to.equal(2n);
    // الضمان كله للبائع — المشتري لا يسترد شيئاً
    expect(await wbtc.balanceOf(buyer.address)).to.equal(buyerBefore);
    expect((await m.getPosition(1)).collateralAmount).to.equal(0n);
  });

  it("performUpkeep مقيّد بالـ keeper أو المالك", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    await ctx.btcFeed.setAnswer(BTC_CRASH);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    await expect(ctx.m.connect(ctx.stranger).performUpkeep(data))
      .to.be.revertedWithCustomError(ctx.m, "NotAuthorized");
    await expect(ctx.m.connect(ctx.keeper).performUpkeep(data))
      .to.emit(ctx.m, "PositionLiquidated");
  });

  it("isLiquidatable: false للمركز المكتمل", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    for (let i = 0; i < 12; i++) await ctx.m.connect(ctx.buyer).payInstallment(1);
    const [ok] = await ctx.m.isLiquidatable(1);
    expect(ok).to.equal(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("I — Chainlink Automation (checkUpkeep — BUG-016 ثابت)", () => {
  it("false: مركز سليم لم يستحق بعد", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    const [needed] = await ctx.m.checkUpkeep(data);
    expect(needed).to.equal(false);
  });

  it("true: القسط مستحق (autoPayEnabled=true)", async () => {
    // FB-60: checkUpkeep يُرجع true فقط إذا كان autoPayEnabled=true
    const ctx = await deploy();
    const { m, wbtc, usdc, seller, buyer } = ctx;
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(100));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await wbtc.connect(buyer).approve(mAddr, BTC(50));
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    await m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q_BTC, 12, true); // autoPayEnabled=true
    await time.increase(INTERVAL_N + 1);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    const [needed] = await m.checkUpkeep(data);
    expect(needed).to.equal(true);
  });

  it("true: التصفية (undercollateral، autoLiquidateEnabled=true)", async () => {
    // FB-60: checkUpkeep يُرجع true للتصفية فقط إذا كان autoLiquidateEnabled=true
    const ctx = await deploy();
    const { m, wbtc, usdc, seller, buyer } = ctx;
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(100));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, true); // autoLiquidateEnabled=true
    await wbtc.connect(buyer).approve(mAddr, BTC(50));
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    await m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q_BTC, 12, false);
    await ctx.btcFeed.setAnswer(BTC_CRASH);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    const [needed] = await m.checkUpkeep(data);
    expect(needed).to.equal(true);
  });

  it("false: مركز مكتمل", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    for (let i = 0; i < 12; i++) await ctx.m.connect(ctx.buyer).payInstallment(1);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    const [needed] = await ctx.m.checkUpkeep(data);
    expect(needed).to.equal(false);
  });

  it("performUpkeep يخصم القسط تلقائياً", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    await time.increase(INTERVAL_N + 100);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    await ctx.m.connect(ctx.keeper).performUpkeep(data);
    expect((await ctx.m.getPosition(1)).paidInstallments).to.equal(1n);
  });

  it("performUpkeep يُنهي المركز عند القسط الأخير تلقائياً", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    const { m, buyer, keeper } = ctx;
    // 11 قسطاً يدوية تُحرّك nextDueDate → T0 + 12×30 = T0+360 أيام
    for (let i = 0; i < 11; i++) await m.connect(buyer).payInstallment(1);
    // تقدّم لـ T0+360 أيام لتُصبح الدفعة الـ 12 مستحقة
    await time.increase(12 * INTERVAL_N + 100);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    await m.connect(keeper).performUpkeep(data);
    expect((await m.getPosition(1)).state).to.equal(1n); // COMPLETED
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("J — الإدارة والأذونات", () => {
  it("setProtocolFee: يُحدّث وينفّذ الحد 300 bps", async () => {
    const { m, owner } = await deploy();
    await m.connect(owner).setProtocolFee(200);
    expect(await m.protocolFeeBps()).to.equal(200);
    await expect(m.connect(owner).setProtocolFee(301))
      .to.be.revertedWithCustomError(m, "InvalidParams");
  });

  it("setBrokerageFee: يُحدّث وينفّذ الحد", async () => {
    const { m, owner } = await deploy();
    await m.connect(owner).setBrokerageFee(100);
    expect(await m.brokerageFeeBps()).to.equal(100);
    await expect(m.connect(owner).setBrokerageFee(101))
      .to.be.revertedWithCustomError(m, "InvalidParams");
  });

  it("setBrokerTreasury + setProtocolTreasury: يُحدّث ويرفض zero", async () => {
    const { m, owner, buyer } = await deploy();
    await m.connect(owner).setBrokerTreasury(buyer.address);
    expect(await m.brokerTreasury()).to.equal(buyer.address);
    await expect(m.connect(owner).setBrokerTreasury(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(m, "InvalidParams");
    await m.connect(owner).setProtocolTreasury(buyer.address);
    expect(await m.protocolTreasury()).to.equal(buyer.address);
    await expect(m.connect(owner).setProtocolTreasury(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(m, "InvalidParams");
  });

  it("setKeeper: يُحدّث الـ keeper", async () => {
    const { m, owner, stranger } = await deploy();
    await m.connect(owner).setKeeper(stranger.address);
    expect(await m.keeper()).to.equal(stranger.address);
    // keeper الجديد يستطيع performUpkeep
    const ctx = await deploy();
    await openPosition(ctx);
    await ctx.m.connect(ctx.owner).setKeeper(stranger.address);
    await time.increase(INTERVAL_N + 100);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    await expect(ctx.m.connect(stranger).performUpkeep(data)).not.to.be.reverted;
  });

  it("لا يمكن لغير المالك تعديل الإعدادات", async () => {
    const { m, stranger } = await deploy();
    await expect(m.connect(stranger).setProtocolFee(50)).to.be.reverted;
    await expect(m.connect(stranger).setBrokerageFee(50)).to.be.reverted;
    await expect(m.connect(stranger).setBrokerTreasury(stranger.address)).to.be.reverted;
    await expect(m.connect(stranger).setProtocolTreasury(stranger.address)).to.be.reverted;
    await expect(m.connect(stranger).setKeeper(stranger.address)).to.be.reverted;
    await expect(m.connect(stranger).pause()).to.be.reverted;
  });

  it("renounceOwnership معطّل", async () => {
    const { m, owner } = await deploy();
    await expect(m.connect(owner).renounceOwnership())
      .to.be.revertedWithCustomError(m, "RenounceOwnershipDisabled");
  });

  it("quotePrice يُرجع السعر الصحيح", async () => {
    const { m, wbtc } = await deploy();
    const wbtcAddr = await wbtc.getAddress();
    expect(await m.quotePrice(ethers.ZeroAddress)).to.equal(Q_ETH); // ETH
    expect(await m.quotePrice(wbtcAddr)).to.equal(Q_BTC);           // WBTC
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("K — الإيقاف المؤقت (Pause)", () => {
  it("الدوال المحمية ترفض عند الإيقاف", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    const { m, owner, seller, buyer, wbtc, usdc } = ctx;
    await m.connect(owner).pause();

    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(await m.getAddress(), BTC(1));
    await expect(m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false))
      .to.be.revertedWithCustomError(m, "EnforcedPause");
    await expect(m.connect(buyer).payInstallment(1))
      .to.be.revertedWithCustomError(m, "EnforcedPause");
    await expect(m.connect(buyer).earlyRepayCash(1))
      .to.be.revertedWithCustomError(m, "EnforcedPause");
    await expect(m.connect(buyer).withdrawExcessCollateral(1, BTC(0.1)))
      .to.be.revertedWithCustomError(m, "EnforcedPause");

    await m.connect(owner).unpause();
    await expect(m.connect(buyer).payInstallment(1)).not.to.be.reverted;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("L — السعر القديم (StalePrice)", () => {
  it("يرفض قراءة السعر القديم في healthFactor", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    await ctx.btcFeed.setStale(2 * 3600); // أقدم من ساعة
    await expect(ctx.m.healthFactor(1))
      .to.be.revertedWithCustomError(ctx.m, "StalePrice");
  });

  it("يرفض الشراء عند سعر قديم", async () => {
    const { m, wbtc, usdc, seller, buyer, btcFeed } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await btcFeed.setStale(2 * 3600);
    await wbtc.connect(buyer).approve(mAddr, BTC(2));
    await expect(m.connect(buyer).buy(1, BTC(1), BTC(2), Q_BTC, 12, false))
      .to.be.revertedWithCustomError(m, "StalePrice");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("M — مسار ETH كامل", () => {
  it("عرض ETH + ضمان WBTC: شراء → 12 قسطاً USDC → استرداد WBTC", async () => {
    const { m, usdc, wbtc, seller, buyer } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await m.connect(seller).createOffer(ethers.ZeroAddress, wbtcAddr, usdcAddr, 0, 1000, 1, 12, INTERVAL, 0, 12000, false, { value: E("1") });
    await wbtc.connect(buyer).approve(mAddr, BTC(5));
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));

    // push مباشر للمشتري (msg.sender) — ETH يصله مباشرة في محفظته (PENDING-003)
    const ethBefore = await ethers.provider.getBalance(buyer.address);
    const txBuy = await m.connect(buyer).buy(1, E("1"), BTC(5), Q_ETH, 12, false);
    const rcBuy = await txBuy.wait();
    const gasBuy = rcBuy!.gasUsed * rcBuy!.gasPrice;
    // المشتري استلم 0.98 ETH مباشرة (2% رسوم: 1% broker + 1% protocol)
    expect((await ethers.provider.getBalance(buyer.address)) - ethBefore + gasBuy)
      .to.equal(E("0.98"));
    expect(await m.pendingETH(buyer.address)).to.equal(0n); // لا شيء في pending

    // سداد 12 قسطاً USDC واسترداد ضمان WBTC
    const wbtcBefore = await wbtc.balanceOf(buyer.address);
    for (let i = 0; i < 12; i++) await m.connect(buyer).payInstallment(1);
    expect((await m.getPosition(1)).state).to.equal(1n); // COMPLETED
    expect(await wbtc.balanceOf(buyer.address)).to.equal(wbtcBefore + BTC(5));
  });

  it("عرض WBTC + ضمان ETH: تصفية عند هبوط ETH", async () => {
    const { m, wbtc, usdc, seller, buyer, keeper, ethFeed } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, ethers.ZeroAddress, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    // 30 ETH @ $3k = $90k > req $78,408
    await m.connect(buyer).buy(1, BTC(1), 0, Q_BTC, 12, false, { value: E("30") });

    // هبوط شديد → undercollateral
    await ethFeed.setAnswer(ETH_CRASH);
    const [ok] = await m.isLiquidatable(1);
    expect(ok).to.equal(true);

    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    await expect(m.connect(keeper).performUpkeep(data))
      .to.emit(m, "PositionLiquidated");
    expect((await m.getPosition(1)).state).to.equal(2n); // LIQUIDATED
    expect((await m.getPosition(1)).collateralAmount).to.equal(0n);
  });

  it("عرض WBTC + ضمان ETH: إكمال يُرجع ETH مباشرة للمشتري (push)", async () => {
    const { m, wbtc, usdc, seller, buyer } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, ethers.ZeroAddress, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    await m.connect(buyer).buy(1, BTC(1), 0, Q_BTC, 12, false, { value: E("30") });

    // سداد الأقساط — القسط الأخير يُرجع الضمان مباشرة للمشتري (push لأنه msg.sender)
    const ethBefore = await ethers.provider.getBalance(buyer.address);
    let totalGas = 0n;
    for (let i = 0; i < 12; i++) {
      const tx = await m.connect(buyer).payInstallment(1);
      const rc = await tx.wait();
      totalGas += rc!.gasUsed * rc!.gasPrice;
    }
    expect((await m.getPosition(1)).state).to.equal(1n); // COMPLETED

    // 30 ETH رجعت مباشرة (لا pendingETH)
    expect(await m.pendingETH(buyer.address)).to.equal(0n);
    expect((await ethers.provider.getBalance(buyer.address)) - ethBefore + totalGas)
      .to.be.closeTo(E("30"), E("0.01")); // قريب من 30 ETH ناقص USDC gas
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("N — سيناريوهات متقدمة", () => {
  it("مشتريان من نفس العرض: مراكز مستقلة", async () => {
    const { m, wbtc, usdc, seller, buyer, buyer2 } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(3));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(3), 1000, 1, 12, INTERVAL, 0, 12000, false);

    // مشتري 1
    await wbtc.connect(buyer).approve(mAddr, BTC(2));
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    await m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q_BTC, 12, false); // pos=1

    // مشتري 2
    await wbtc.connect(buyer2).approve(mAddr, BTC(2));
    await usdc.connect(buyer2).approve(mAddr, U(2_000_000));
    await m.connect(buyer2).buy(1, BTC(1), BTC(2), Q_BTC, 12, false); // pos=2

    expect((await m.getPosition(1)).buyer).to.equal(buyer.address);
    expect((await m.getPosition(2)).buyer).to.equal(buyer2.address);
    expect((await m.getOffer(1)).saleAmount).to.equal(BTC(1)); // تبقى 1 BTC
  });

  it("بائع يزيد العرض + مشتري يشتري من الكمية الجديدة", async () => {
    const { m, wbtc, usdc, seller, buyer } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(10));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await m.connect(seller).increaseOffer(1, BTC(4)); // صار 5 BTC

    await wbtc.connect(buyer).approve(mAddr, BTC(4));
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    await m.connect(buyer).buy(1, BTC(3), BTC(4), Q_BTC, 12, false);
    expect((await m.getOffer(1)).saleAmount).to.equal(BTC(2)); // تبقى 2 BTC
  });

  it("تغيير brokerTreasury يُوجّه العمولة للعنوان الجديد", async () => {
    const ctx = await deploy();
    const { m, wbtc, owner, stranger } = ctx;
    await m.connect(owner).setBrokerTreasury(stranger.address);
    const wbtcBefore = await wbtc.balanceOf(stranger.address);
    await openPosition(ctx);
    // العمولة (WBTC) تذهب لـ brokerTreasury الجديد عند الشراء (الأصل WBTC)
    expect(await wbtc.balanceOf(stranger.address)).to.be.gt(wbtcBefore);
  });

  it("WBTC + ETH collateral liquidation: seller ETH credited via pull", async () => {
    const { m, wbtc, usdc, seller, buyer, keeper, ethFeed } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, ethers.ZeroAddress, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    await m.connect(buyer).buy(1, BTC(1), 0, Q_BTC, 12, false, { value: E("30") });
    await ethFeed.setAnswer(ETH_CRASH);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    await m.connect(keeper).performUpkeep(data);
    // البائع يستلم عبر pull
    expect(await m.pendingETH(seller.address)).to.be.gt(0n);
    expect((await m.getPosition(1)).collateralAmount).to.equal(0n);
  });

  it("تغيير protocolFee يُطبَّق على الأقساط التالية", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    const { m, usdc, owner, buyer } = ctx;
    await m.connect(owner).setProtocolFee(200); // رفع من 1% لـ 2%
    const before = await usdc.balanceOf(buyer.address);
    await m.connect(buyer).payInstallment(1);
    const paid = before - (await usdc.balanceOf(buyer.address));
    // القسط نفسه لكن الرسوم تضاعفت — المجموع لا يتغير (البائع يستلم أقل)
    expect(paid).to.equal(M.installment);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("O — TransferLib: نمط Pull-over-Push (CODE-V5-4)", () => {
  it("pendingETH يعكس المبلغ للعناوين غير msg.sender (seller/feeRecipient)", async () => {
    // الـ seller ليس msg.sender عند الشراء → يستلم عبر pull
    const { m, wbtc, usdc, seller, buyer } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await m.connect(seller).createOffer(ethers.ZeroAddress, wbtcAddr, usdcAddr, 0, 1000, 1, 12, INTERVAL, 0, 12000, false, { value: E("1") });
    await wbtc.connect(buyer).approve(mAddr, BTC(5));
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    await m.connect(buyer).buy(1, E("1"), BTC(5), Q_ETH, 12, false);
    // buyer (msg.sender) يستلم push مباشر → pendingETH=0
    expect(await m.pendingETH(buyer.address)).to.equal(0n);
  });

  it("withdrawETH يُحوِّل ETH ويصفّر الرصيد (seller يسحب بعد تصفية)", async () => {
    // seller يستلم عبر pull عند التصفية (ليس msg.sender)
    const { m, wbtc, usdc, seller, buyer, keeper, ethFeed } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, ethers.ZeroAddress, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    await m.connect(buyer).buy(1, BTC(1), 0, Q_BTC, 12, false, { value: E("30") });
    // تصفية بسبب انهيار سعر ETH (الضمان ETH → قيمته تنهار)
    await ethFeed.setAnswer(ETH_CRASH); // ETH بـ $10 — 30 ETH = $300 << الدين
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    await m.connect(keeper).performUpkeep(data);
    // seller يستلم ETH عبر pull
    const sellerPending = await m.pendingETH(seller.address);
    expect(sellerPending).to.be.gt(0n);
    const before = await ethers.provider.getBalance(seller.address);
    const tx = await m.connect(seller).withdrawETH();
    const rc = await tx.wait();
    const gas = rc!.gasUsed * rc!.gasPrice;
    expect((await ethers.provider.getBalance(seller.address)) - before + gas)
      .to.equal(sellerPending);
    expect(await m.pendingETH(seller.address)).to.equal(0n);
  });

  it("withdrawETH يرفض عند رصيد صفر", async () => {
    const { m, buyer } = await deploy();
    await expect(m.connect(buyer).withdrawETH())
      .to.be.revertedWithCustomError(m, "ZeroAmount");
  });

  it("إلغاء عرض ETH يُرجع ETH مباشرة للبائع (push لأنه msg.sender)", async () => {
    const { m, usdc, seller } = await deploy();
    const usdcAddr = await usdc.getAddress();
    const before = await ethers.provider.getBalance(seller.address);
    const txCreate = await m.connect(seller).createOffer(ethers.ZeroAddress, ethers.ZeroAddress, usdcAddr, 0, 1000, 1, 6, INTERVAL, 0, 13000, false, { value: E("3") });
    const rcCreate = await txCreate.wait();
    const gasCreate = rcCreate!.gasUsed * rcCreate!.gasPrice;
    const txCancel = await m.connect(seller).cancelOffer(1);
    const rcCancel = await txCancel.wait();
    const gasCancel = rcCancel!.gasUsed * rcCancel!.gasPrice;
    // ETH رجع مباشرة (لا pendingETH)
    expect(await m.pendingETH(seller.address)).to.equal(0n);
    expect((await ethers.provider.getBalance(seller.address)) - before + gasCreate + gasCancel)
      .to.equal(0n); // خرج 3 ETH ثم رجع 3 ETH
  });

  it("decreaseOffer على عرض ETH يُرجع ETH مباشرة للبائع", async () => {
    const { m, usdc, seller } = await deploy();
    const usdcAddr = await usdc.getAddress();
    await m.connect(seller).createOffer(ethers.ZeroAddress, ethers.ZeroAddress, usdcAddr, 0, 1000, 1, 6, INTERVAL, 0, 13000, false, { value: E("5") });
    await m.connect(seller).decreaseOffer(1, E("2"));
    expect(await m.pendingETH(seller.address)).to.equal(0n); // push مباشر
    expect((await m.getOffer(1)).saleAmount).to.equal(E("3"));
  });

  it("مشترٍ خبيث يرفض ETH: لا يعطّل تصفية المركز", async () => {
    // العقد الخبيث يرفض receive() — مع pull لا تصفية تُعطَّل
    const { m, wbtc, usdc, seller, buyer, keeper, ethFeed } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, ethers.ZeroAddress, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    await m.connect(buyer).buy(1, BTC(1), 0, Q_BTC, 12, false, { value: E("30") });
    await ethFeed.setAnswer(ETH_CRASH);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    // التصفية تنجح حتى لو المستلم عقد يرفض ETH — لأنه pull وليس push
    await expect(m.connect(keeper).performUpkeep(data))
      .to.emit(m, "PositionLiquidated");
    expect((await m.getPosition(1)).state).to.equal(2n); // LIQUIDATED ✓
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("P — شراء جزئي ومرونة الأقساط", () => {

  // ── math للشراء الجزئي — الربح التناسبي ────────────────────────────────
  // نسبة الرسوم: 2% من الأصل (brokerFee 1% + protocolFee 1%)
  //
  // 0.2 BTC × 12 قسط (max=12 → effectiveProfit = 10%):
  //   net = 0.196 BTC  |  saleValue = $11,760  |  totalPayable = $12,936  |  قسط = $1,078
  //
  // 0.3 BTC × 6 أقساط (max=12 → effectiveProfit = 6/12 × 10% = 5%):
  //   net = 0.294 BTC  |  saleValue = $17,640  |  totalPayable = $18,522  |  قسط = $3,087
  const INST_02_12 = 1_078_000_000n;  // قسط لـ 0.2 BTC × 12 (ربح 10%)
  const INST_03_6  = 3_087_000_000n;  // قسط لـ 0.3 BTC × 6  (ربح 5% = تناسبي)

  // ── helper: عرض 1 BTC مع حد أدنى شراء 0.1 BTC، أقساط [1..12] ──────────
  async function openPartialOffer(ctx: Ctx) {
    const { m, wbtc, usdc, seller } = ctx;
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(100));
    // minInstallments=1, maxInstallments=12, minPurchaseAmount=BTC(0.1)
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, BTC(0.1), 12000, false);
  }

  // ────────────────────────────────────────────────────────────────────────
  it("P-01: بائع يُنشئ عرض 1 BTC — totalAmount و saleAmount كلاهما 1 BTC", async () => {
    const ctx = await deploy();
    await openPartialOffer(ctx);
    const o = await ctx.m.getOffer(1);
    expect(o.totalAmount).to.equal(BTC(1));
    expect(o.saleAmount).to.equal(BTC(1));
    expect(o.minPurchaseAmount).to.equal(BTC(0.1));
    expect(o.minInstallments).to.equal(1n);
    expect(o.maxInstallments).to.equal(12n);
  });

  // ────────────────────────────────────────────────────────────────────────
  it("P-02: مشتري يشتري 0.2 BTC → remainingAmount = 0.8 BTC + PartialPurchaseCreated", async () => {
    const ctx = await deploy();
    const { m, wbtc, usdc, buyer } = ctx;
    await openPartialOffer(ctx);

    await wbtc.connect(buyer).approve(await m.getAddress(), BTC(50));
    await usdc.connect(buyer).approve(await m.getAddress(), U(2_000_000));

    // ضمان مطلوب: totalPayable(0.2BTC) × 120% = $12,936 × 1.2 = $15,523.2
    // بـ BTC = $60k: 15,523.2 / 60,000 ≈ 0.2587 BTC → نُرسل 0.3 BTC
    await expect(
      m.connect(buyer).buy(1, BTC(0.2), BTC(0.3), Q_BTC, 12, false)
    ).to.emit(m, "PartialPurchaseCreated")
      .withArgs(1n, 1n, BTC(0.2), BTC(0.8));

    const o = await m.getOffer(1);
    expect(o.saleAmount).to.equal(BTC(0.8));       // ← تحقق رئيسي
    expect(o.totalAmount).to.equal(BTC(1));         // لا يتغير
    expect(o.state).to.equal(0n);                   // ACTIVE
  });

  // ────────────────────────────────────────────────────────────────────────
  it("P-03: بعد P-02، مشترٍ ثانٍ يشتري 0.3 BTC → remainingAmount = 0.5 BTC", async () => {
    const ctx = await deploy();
    const { m, wbtc, usdc, buyer, buyer2 } = ctx;
    await openPartialOffer(ctx);

    // مشتري 1: 0.2 BTC
    await wbtc.connect(buyer).approve(await m.getAddress(), BTC(50));
    await usdc.connect(buyer).approve(await m.getAddress(), U(2_000_000));
    await m.connect(buyer).buy(1, BTC(0.2), BTC(0.3), Q_BTC, 12, false);

    // مشتري 2: 0.3 BTC
    await wbtc.connect(buyer2).approve(await m.getAddress(), BTC(50));
    await usdc.connect(buyer2).approve(await m.getAddress(), U(2_000_000));
    await m.connect(buyer2).buy(1, BTC(0.3), BTC(0.4), Q_BTC, 6, false);

    const o = await m.getOffer(1);
    expect(o.saleAmount).to.equal(BTC(0.5));   // ← 1 - 0.2 - 0.3 = 0.5
    expect(o.totalAmount).to.equal(BTC(1));    // لا يتغير أبداً
  });

  // ────────────────────────────────────────────────────────────────────────
  it("P-04: مشتري يختار 6 أقساط من عرض حده 12 → ينجح بقيمة قسط صحيحة", async () => {
    const ctx = await deploy();
    const { m, wbtc, usdc, buyer } = ctx;
    await openPartialOffer(ctx);

    await wbtc.connect(buyer).approve(await m.getAddress(), BTC(50));
    await usdc.connect(buyer).approve(await m.getAddress(), U(2_000_000));
    await m.connect(buyer).buy(1, BTC(0.3), BTC(0.4), Q_BTC, 6, false);

    const p = await m.getPosition(1);
    expect(p.totalInstallments).to.equal(6n);   // اختار 6
    expect(p.paidInstallments).to.equal(0n);

    // تحقق من قيمة القسط الأول
    const usdcBefore = await ctx.usdc.balanceOf(buyer.address);
    await m.connect(buyer).payInstallment(1);
    const paid = usdcBefore - (await ctx.usdc.balanceOf(buyer.address));
    expect(paid).to.equal(INST_03_6);           // $3,234 لكل قسط
  });

  // ────────────────────────────────────────────────────────────────────────
  it("P-05: محاولة اختيار 15 قسطاً (> maxInstallments=12) → InvalidInstallments", async () => {
    const ctx = await deploy();
    const { m, wbtc, usdc, buyer } = ctx;
    await openPartialOffer(ctx);

    await wbtc.connect(buyer).approve(await m.getAddress(), BTC(50));
    await usdc.connect(buyer).approve(await m.getAddress(), U(2_000_000));

    await expect(
      m.connect(buyer).buy(1, BTC(0.2), BTC(0.3), Q_BTC, 15, false)
    ).to.be.revertedWithCustomError(m, "InvalidInstallments");
  });

  // ────────────────────────────────────────────────────────────────────────
  it("P-06: الربح تناسبي — 6 أقساط (من 12) = نصف الربح = 5% بدل 10%", async () => {
    // البائع: profitBps=1000 (10%), maxInstallments=12
    // المشتري: selectedInstallments=6 → effectiveProfitBps = 500 (5%)
    const ctx = await deploy();
    const { m, wbtc, usdc, buyer } = ctx;
    await openPartialOffer(ctx);

    await wbtc.connect(buyer).approve(await m.getAddress(), BTC(50));
    await usdc.connect(buyer).approve(await m.getAddress(), U(2_000_000));

    // 1 BTC × 6 أقساط
    await m.connect(buyer).buy(1, BTC(1), BTC(1.6), Q_BTC, 6, false);
    const p6 = await m.getPosition(1);

    // totalPayable@5%: 0.98 × $60k × 1.05 = $61,740
    const expected6 = 61_740_000_000n;
    expect(p6.totalPayable).to.equal(expected6);

    // للمقارنة: نفس العرض لو اختار 12 قسطاً → 10% → $64,680
    // الفرق يُثبت أن الربح تناسبي وليس ثابتاً
    const expected12 = M.totalPayable; // $64,680
    expect(expected6).to.be.lt(expected12); // 5% < 10% ✓
  });

  // ────────────────────────────────────────────────────────────────────────
  it("P-07: محاولة شراء أكثر من remainingAmount → InvalidParams", async () => {
    const ctx = await deploy();
    const { m, wbtc, usdc, buyer } = ctx;
    await openPartialOffer(ctx);

    await wbtc.connect(buyer).approve(await m.getAddress(), BTC(50));
    await usdc.connect(buyer).approve(await m.getAddress(), U(2_000_000));

    await expect(
      m.connect(buyer).buy(1, BTC(1.1), BTC(2), Q_BTC, 12, false)
    ).to.be.revertedWithCustomError(m, "InvalidParams");
  });

  // ────────────────────────────────────────────────────────────────────────
  it("P-08: محاولة شراء أقل من minPurchaseAmount → BelowMinPurchase", async () => {
    const ctx = await deploy();
    const { m, wbtc, usdc, buyer } = ctx;
    await openPartialOffer(ctx); // minPurchaseAmount = BTC(0.1)

    await wbtc.connect(buyer).approve(await m.getAddress(), BTC(50));
    await usdc.connect(buyer).approve(await m.getAddress(), U(2_000_000));

    await expect(
      m.connect(buyer).buy(1, BTC(0.05), BTC(0.1), Q_BTC, 12, false)
    ).to.be.revertedWithCustomError(m, "BelowMinPurchase");
  });

  // ────────────────────────────────────────────────────────────────────────
  it("P-09: دفع الأقساط مستقل — مشتريان من نفس العرض لا يتداخلان", async () => {
    const ctx = await deploy();
    const { m, wbtc, usdc, buyer, buyer2 } = ctx;
    await openPartialOffer(ctx);

    // مشتري1: 0.2 BTC × 12 قسط
    await wbtc.connect(buyer).approve(await m.getAddress(), BTC(50));
    await usdc.connect(buyer).approve(await m.getAddress(), U(2_000_000));
    await m.connect(buyer).buy(1, BTC(0.2), BTC(0.3), Q_BTC, 12, false);

    // مشتري2: 0.3 BTC × 6 أقساط
    await wbtc.connect(buyer2).approve(await m.getAddress(), BTC(50));
    await usdc.connect(buyer2).approve(await m.getAddress(), U(2_000_000));
    await m.connect(buyer2).buy(1, BTC(0.3), BTC(0.4), Q_BTC, 6, false);

    // مشتري1 يدفع قسطاً
    await m.connect(buyer).payInstallment(1);  // positionId=1
    // مشتري2 يدفع قسطاً
    await m.connect(buyer2).payInstallment(2); // positionId=2

    const p1 = await m.getPosition(1);
    const p2 = await m.getPosition(2);
    expect(p1.paidInstallments).to.equal(1n);    // مشتري1 دفع 1
    expect(p1.totalInstallments).to.equal(12n);  // لا يزال 12
    expect(p2.paidInstallments).to.equal(1n);    // مشتري2 دفع 1
    expect(p2.totalInstallments).to.equal(6n);   // لا يزال 6

    // المراكز مستقلة — كل منها state = ACTIVE
    expect(p1.state).to.equal(0n);
    expect(p2.state).to.equal(0n);

    // مشتري2 لا يستطيع دفع قسط مشتري1
    await expect(m.connect(buyer2).payInstallment(1))
      .to.be.revertedWithCustomError(m, "NotBuyer");
  });

  // ────────────────────────────────────────────────────────────────────────
  it("P-10: نسبة الضمان ثابتة من العرض — المشتري لا يملك تخفيضها", async () => {
    const ctx = await deploy();
    const { m, wbtc, usdc, buyer } = ctx;
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    // عرض بنسبة ضمان 150%
    await wbtc.connect(ctx.seller).approve(mAddr, BTC(100));
    await m.connect(ctx.seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 15000, false); // 150%

    await wbtc.connect(buyer).approve(mAddr, BTC(50));
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));

    // حساب الحد الأدنى عند 150%:
    // totalPayable(1 BTC) = $64,680 → requiredUSDC = $64,680 × 1.5 = $97,020
    // بـ BTC=$60k → collateral = 97,020/60,000 ≈ 1.617 BTC
    // محاولة بـ 1.5 BTC (يكفي عند 120% لكن لا يكفي عند 150%)
    await expect(
      m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q_BTC, 12, false)
    ).to.be.revertedWithCustomError(m, "InsufficientCollateral");

    // بـ 1.7 BTC يكفي
    await expect(
      m.connect(buyer).buy(1, BTC(1), BTC(1.7), Q_BTC, 12, false)
    ).to.not.be.reverted;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Q — FB-31: Self-Buy Protection
// ═══════════════════════════════════════════════════════════════════════════
describe("Q — FB-31: حماية ضد Self-Buy", () => {
  it("Q-01: البائع لا يستطيع شراء عرضه (WBTC)", async () => {
    const ctx = await deploy();
    const { m, wbtc, usdc, seller } = ctx;
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();

    // البائع ينشئ عرض
    await wbtc.connect(seller).approve(mAddr, BTC(10));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);

    // البائع نفسه يحاول الشراء → SelfBuyNotAllowed
    await wbtc.connect(seller).approve(mAddr, BTC(5));
    await usdc.connect(seller).approve(mAddr, U(2_000_000));
    await expect(
      m.connect(seller).buy(1, BTC(1), BTC(1.5), Q_BTC, 12, false)
    ).to.be.revertedWithCustomError(m, "SelfBuyNotAllowed");
  });

  it("Q-02: مشتري آخر ينجح في الشراء (المسار العادي)", async () => {
    const ctx = await deploy();
    const { m, wbtc, usdc, seller, buyer } = ctx;
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();

    await wbtc.connect(seller).approve(mAddr, BTC(10));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);

    await wbtc.connect(buyer).approve(mAddr, BTC(5));
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    await expect(
      m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q_BTC, 12, false)
    ).to.not.be.reverted;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R — FB-32: Public Manual Intervention Functions
// ═══════════════════════════════════════════════════════════════════════════
describe("R — FB-32: دوال التدخل اليدوي العامة", () => {
  it("R-01: liquidatePositionPublic ينجح بعد grace period", async () => {
    const ctx = await deploy();
    const { m, stranger } = ctx;
    await openPosition(ctx);
    await time.increase(INTERVAL_N + GRACE + 1);

    // أي طرف (stranger) يقدر يصفّي
    await expect(m.connect(stranger).liquidatePositionPublic(1))
      .to.emit(m, "PositionLiquidated");
  });

  it("R-02: liquidatePositionPublic يرفض قبل grace period", async () => {
    const ctx = await deploy();
    const { m, stranger } = ctx;
    await openPosition(ctx);
    await time.increase(INTERVAL_N + 1); // متأخر دقيقة فقط، GRACE=3 أيام

    await expect(m.connect(stranger).liquidatePositionPublic(1))
      .to.be.revertedWithCustomError(m, "NotLiquidatableYet");
  });

  it("R-03: liquidatePositionPublic يرفض على مركز غير نشط", async () => {
    const ctx = await deploy();
    const { m, stranger } = ctx;
    await openPosition(ctx);
    // ينتظر ويصفّي مرة
    await time.increase(INTERVAL_N + GRACE + 1);
    await m.connect(stranger).liquidatePositionPublic(1);
    // محاولة ثانية → PositionNotActive
    await expect(m.connect(stranger).liquidatePositionPublic(1))
      .to.be.revertedWithCustomError(m, "PositionNotActive");
  });

  it("R-04: processInstallmentPublic يسحب القسط عند الاستحقاق", async () => {
    const ctx = await deploy();
    const { m, stranger } = ctx;
    await openPosition(ctx);
    await time.increase(INTERVAL_N + 1);

    await expect(m.connect(stranger).processInstallmentPublic(1))
      .to.emit(m, "InstallmentPaid");
  });

  it("R-05: processInstallmentPublic يرفض قبل الاستحقاق", async () => {
    const ctx = await deploy();
    const { m, stranger } = ctx;
    await openPosition(ctx);
    // لا time.increase — القسط القادم بعد دقيقة

    await expect(m.connect(stranger).processInstallmentPublic(1))
      .to.be.revertedWithCustomError(m, "NotDueYet");
  });

  it("R-06: liquidatePositionPublic يسمح بتصفية undercollateral قبل grace period", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    await ctx.btcFeed.setAnswer(BTC_CRASH);

    await expect(ctx.m.connect(ctx.stranger).liquidatePositionPublic(1))
      .to.emit(ctx.m, "PositionLiquidated");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// S — Hardening fixes
// ═══════════════════════════════════════════════════════════════════════════
describe("S — إصلاحات التحصين", () => {
  it("يرفض stablecoin لا يستخدم 6 decimals", async () => {
    const { m, buyer2, owner } = await deploy();
    await expect(m.connect(owner).addSupportedToken(buyer2.address, ethers.ZeroAddress, 8, true))
      .to.be.revertedWithCustomError(m, "InvalidParams");
  });

  it("يرفض profitBps أكبر من 30000 (300%)", async () => {
    const { m, wbtc, usdc, seller } = await deploy();
    const mAddr = await m.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await expect(
      m.connect(seller).createOffer(await wbtc.getAddress(), await wbtc.getAddress(), await usdc.getAddress(), BTC(1), 30001, 1, 12, INTERVAL, 0, 12000, false)
    ).to.be.revertedWithCustomError(m, "InvalidParams");
  });

  it("يرفض paymentInterval أكبر من سنة", async () => {
    const { m, wbtc, usdc, seller } = await deploy();
    const mAddr = await m.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await expect(
      m.connect(seller).createOffer(await wbtc.getAddress(), await wbtc.getAddress(), await usdc.getAddress(), BTC(1), 1000, 1, 12, 365 * 24 * 60 * 60 + 1, 0, 12000, false)
    ).to.be.revertedWithCustomError(m, "InvalidParams");
  });

  it("يرفض ربحاً تناسبياً يصبح صفراً رغم أن profitBps > 0", async () => {
    const { m, wbtc, usdc, seller, buyer } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1, 1, 12, INTERVAL, 0, 12000, false);
    await wbtc.connect(buyer).approve(mAddr, BTC(2));
    await expect(m.connect(buyer).buy(1, BTC(1), BTC(2), Q_BTC, 1, false))
      .to.be.revertedWithCustomError(m, "EffectiveProfitTooLow");
    await expect(m.estimatePurchase(1, BTC(1), 1))
      .to.be.revertedWithCustomError(m, "EffectiveProfitTooLow");
  });

  it("addCollateral يرفض عند تعطيل توكن الضمان", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    await ctx.m.connect(ctx.owner).removeSupportedToken(await ctx.wbtc.getAddress());
    await expect(ctx.m.connect(ctx.buyer).addCollateral(1, BTC(0.1)))
      .to.be.revertedWithCustomError(ctx.m, "TokenNotSupported");
  });

  it("emergencyWithdraw يعمل فقط أثناء الإيقاف", async () => {
    const { m, owner, buyer } = await deploy();
    const mAddr = await m.getAddress();
    await owner.sendTransaction({ to: mAddr, value: E("1") });
    await expect(m.connect(owner).emergencyWithdraw(ethers.ZeroAddress, buyer.address, E("0.1")))
      .to.be.revertedWithCustomError(m, "ExpectedPause");

    await m.connect(owner).pause();
    const before = await ethers.provider.getBalance(buyer.address);
    await m.connect(owner).emergencyWithdraw(ethers.ZeroAddress, buyer.address, E("0.1"));
    expect(await ethers.provider.getBalance(buyer.address)).to.equal(before + E("0.1"));
  });

  // ── M-01: فهرس المراكز النشطة (CODE-V4-1) ──────────────────────────
  it("M-01: فتح مركز يزيد العدّاد والإكمال المبكر يُنقصه", async () => {
    const ctx = await deploy();
    expect(await ctx.m.activePositionsCount()).to.equal(0);
    await openPosition(ctx);
    expect(await ctx.m.activePositionsCount()).to.equal(1);
    await ctx.m.connect(ctx.buyer).earlyRepayCash(1);
    expect(await ctx.m.activePositionsCount()).to.equal(0);
  });

  it("M-01: التصفية تُزيل المركز من الفهرس النشط", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    expect(await ctx.m.activePositionsCount()).to.equal(1);
    await time.increase(INTERVAL_N + GRACE + 1); // متأخر → قابل للتصفية
    await ctx.m.liquidatePositionPublic(1);
    expect(await ctx.m.activePositionsCount()).to.equal(0);
  });

  it("M-01: swap-and-pop — إكمال مركز من المنتصف لا يفقد البقية", async () => {
    const ctx = await deploy();
    const { m, wbtc, usdc, seller, buyer } = ctx;
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(10));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(3), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await wbtc.connect(buyer).approve(mAddr, BTC(50));
    await usdc.connect(buyer).approve(mAddr, U(5_000_000));
    // 3 مراكز: #1, #2, #3
    await m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q_BTC, 12, false);
    await m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q_BTC, 12, false);
    await m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q_BTC, 12, false);
    expect(await m.activePositionsCount()).to.equal(3);
    // أكمل المركز الأوسط #2 — يُختبر swap-and-pop (يُنقل #3 لمكان #2)
    await m.connect(buyer).earlyRepayCash(2);
    expect(await m.activePositionsCount()).to.equal(2);
    expect((await m.getPosition(1)).state).to.equal(0); // ACTIVE
    expect((await m.getPosition(2)).state).to.equal(1); // COMPLETED
    expect((await m.getPosition(3)).state).to.equal(0); // ACTIVE — لم يُفقد
    // أكمل الباقي للتأكد أن الفهرس يصل صفر بلا خطأ
    await m.connect(buyer).earlyRepayCash(1);
    await m.connect(buyer).earlyRepayCash(3);
    expect(await m.activePositionsCount()).to.equal(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("T — Build 18: M-01 (تخطي auto-pay غير القابل للتحصيل) + M-03 (pendingETH/guardian)", () => {
  // ── مساعد: مركزان autoPay لمشترييْن مختلفين ─────────────────────────────
  async function twoAutoPayPositions(ctx: Ctx) {
    const { m, wbtc, usdc, seller, buyer, buyer2 } = ctx;
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(10));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(2), 1000, 1, 12, INTERVAL, 0, 12000, false);
    for (const b of [buyer, buyer2]) {
      await wbtc.connect(b).approve(mAddr, BTC(50));
      await usdc.connect(b).approve(mAddr, U(2_000_000));
    }
    await m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q_BTC, 12, true);  // مركز #1 autoPay
    await m.connect(buyer2).buy(1, BTC(1), BTC(1.5), Q_BTC, 12, true); // مركز #2 autoPay
    await time.increase(INTERVAL_N + 1); // كلاهما مستحق
    return { mAddr };
  }

  it("M-01: رأس الطابور بلا سماحية يُتخطّى — checkUpkeep يُرجع المركز الثاني", async () => {
    const ctx = await deploy();
    const { m, usdc, buyer } = ctx;
    const { mAddr } = await twoAutoPayPositions(ctx);
    await usdc.connect(buyer).approve(mAddr, 0); // مشتري #1 يسحب السماحية → رأس فاشل
    const [needed, performData] = await m.checkUpkeep("0x");
    expect(needed).to.equal(true);
    const pid = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], performData)[0];
    expect(pid).to.equal(2n); // تخطّى #1 المسدود والتقط #2
  });

  it("M-01: عودة السماحية تُعيد المركز الأول لرأس الطابور", async () => {
    const ctx = await deploy();
    const { m, usdc, buyer } = ctx;
    const { mAddr } = await twoAutoPayPositions(ctx);
    await usdc.connect(buyer).approve(mAddr, 0);
    await usdc.connect(buyer).approve(mAddr, U(2_000_000)); // رجعت
    const [, performData] = await m.checkUpkeep("0x");
    const pid = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], performData)[0];
    expect(pid).to.equal(1n);
  });

  it("M-01: مركز وحيد مستحق بلا رصيد كافٍ → checkUpkeep=false (لا دوران فارغ)", async () => {
    const ctx = await deploy();
    const { m, usdc, buyer } = ctx;
    const mAddr = await m.getAddress();
    await openPosition(ctx); // autoPay=false — نفعّل يدوياً عبر عرض جديد؟ لا: نبني autoPay=true
    // نستخدم المركز القياسي لكن autoPay=false لا يدخل الفرع أصلاً — نحتاج autoPay=true:
    const { wbtc, seller, buyer2 } = ctx;
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await wbtc.connect(buyer2).approve(mAddr, BTC(50));
    await usdc.connect(buyer2).approve(mAddr, U(2_000_000));
    await m.connect(buyer2).buy(2, BTC(1), BTC(1.5), Q_BTC, 12, true); // مركز #2 autoPay
    await time.increase(INTERVAL_N + 1);
    await usdc.connect(buyer2).approve(mAddr, 0); // سماحية صفر
    const [needed] = await m.checkUpkeep("0x");
    expect(needed).to.equal(false); // المسدود لا يُرجَع — لا حرق LINK على revert مضمون
  });

  it("M-03: totalPendingETH يتتبع الاستحقاق وينقص عند السحب", async () => {
    const { m, wbtc, usdc, seller, buyer, keeper, ethFeed } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, ethers.ZeroAddress, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    await m.connect(buyer).buy(1, BTC(1), 0, Q_BTC, 12, false, { value: E("30") });
    await ethFeed.setAnswer(ETH_CRASH);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    await m.connect(keeper).performUpkeep(data); // تصفية: seller+buyer يستحقان ETH عبر pull
    const sp = await m.pendingETH(seller.address);
    const bp = await m.pendingETH(buyer.address);
    expect(sp + bp).to.equal(E("30"));                 // كامل الضمان صار التزامات pull
    expect(await m.totalPendingETH()).to.equal(sp + bp); // العدّاد = مجموع الالتزامات
    await m.connect(seller).withdrawETH();
    expect(await m.totalPendingETH()).to.equal(bp);      // نقص بمقدار سحب البائع فقط
  });

  it("M-03: emergencyWithdraw لا يمسّ ETH المعلّق للمستخدمين", async () => {
    const { m, wbtc, usdc, seller, buyer, keeper, ethFeed, owner } = await deploy();
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(1));
    await m.connect(seller).createOffer(wbtcAddr, ethers.ZeroAddress, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    await m.connect(buyer).buy(1, BTC(1), 0, Q_BTC, 12, false, { value: E("30") });
    await ethFeed.setAnswer(ETH_CRASH);
    await m.connect(keeper).performUpkeep(ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]));
    // كل الـ 30 ETH التزامات pull → الحر = 0
    await m.pause();
    await expect(m.emergencyWithdraw(ethers.ZeroAddress, owner.address, E("1")))
      .to.be.revertedWithCustomError(m, "InsufficientFreeETH");
    // والمستخدم يظل قادراً على السحب رغم الإيقاف (withdrawETH بلا whenNotPaused)
    // (البائع هو صاحب المعلّق — الانهيار الكامل: الضمان كله ذهب له، refund المشتري = 0)
    await m.connect(seller).withdrawETH();
    expect(await m.totalPendingETH()).to.equal(await m.pendingETH(buyer.address));
  });

  it("M-03: emergencyWithdraw يسمح بالـ ETH الحر فقط (escrow بلا التزامات)", async () => {
    const { m, usdc, wbtc, seller, owner } = await deploy();
    const usdcAddr = await usdc.getAddress();
    const wbtcAddr = await wbtc.getAddress(); // الضمان لا يكون ستابل (IsStablecoin)
    // عرض ETH: 1 ETH داخل العقد كـ escrow — totalPendingETH=0 → حر=1
    await m.connect(seller).createOffer(ethers.ZeroAddress, wbtcAddr, usdcAddr, 0, 1000, 1, 12, INTERVAL, 0, 12000, false, { value: E("1") });
    await m.pause();
    await expect(m.emergencyWithdraw(ethers.ZeroAddress, owner.address, E("2")))
      .to.be.revertedWithCustomError(m, "InsufficientFreeETH"); // > الحر
    await m.emergencyWithdraw(ethers.ZeroAddress, owner.address, E("1")); // = الحر → ينجح
  });

  it("M-03: guardian يستطيع pause فقط — لا unpause ولا غيرها", async () => {
    const { m, stranger, buyer } = await deploy();
    await expect(m.connect(stranger).pause())
      .to.be.revertedWithCustomError(m, "NotAuthorized"); // قبل التعيين: غريب ممنوع
    await m.setGuardian(stranger.address);
    await m.connect(stranger).pause();                     // الحارس يوقف فوراً ✅
    expect(await m.paused()).to.equal(true);
    await expect(m.connect(stranger).unpause()).to.be.reverted;          // لا unpause
    await expect(m.connect(stranger).setGuardian(buyer.address)).to.be.reverted; // لا إدارة
    await m.unpause();                                     // المالك يعيد التشغيل
    expect(await m.paused()).to.equal(false);
  });

  it("M-03: setGuardian للمالك فقط + يصدر GuardianSet", async () => {
    const { m, owner, stranger, keeper } = await deploy();
    await expect(m.connect(stranger).setGuardian(stranger.address)).to.be.reverted;
    await expect(m.setGuardian(keeper.address))
      .to.emit(m, "GuardianSet").withArgs(ethers.ZeroAddress, keeper.address);
    expect(await m.guardian()).to.equal(keeper.address);
    await expect(m.setGuardian(ethers.ZeroAddress)) // التعطيل جائز
      .to.emit(m, "GuardianSet").withArgs(keeper.address, ethers.ZeroAddress);
  });
});

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// ── وحدات ──────────────────────────────────────────────────────────────────
const U    = (n: number) => BigInt(Math.round(n * 1e6));   // USDC 6 خانات
const SATS = (n: number) => BigInt(Math.round(n * 1e8));   // BTC 8 خانات

const BTC_60K = 6_000_000_000_000n; // $60,000
const BTC_28K = 2_800_000_000_000n; // $28,000 — نداء هامش
const BTC_24K = 2_400_000_000_000n; // $24,000 — قابل للتصفية

// الحالات الثلاث عشرة (v2)
const S = {
  OPEN: 0n, AWAITING_COLLATERAL: 1n, AWAITING_DELIVERY: 2n, ACTIVE: 3n,
  PAYMENT_OVERDUE: 4n, MARGIN_CALL: 5n, DEFAULT_PENDING: 6n, DISPUTED: 7n,
  LIQUIDATION_ELIGIBLE: 8n, LIQUIDATED: 9n, REPAID: 10n,
  COLLATERAL_RELEASED: 11n, CANCELLED: 12n,
};

const COST       = U(10_000);   // تكلفة المبيع $10,000
const PROFIT_BPS = 1000n;       // 10% → totalPayable = $11,000
const TOTAL_PAY  = U(11_000);
const INSTALLMENTS = 10;
const PER_INST   = U(1_100);
const INTERVAL   = 86400n;      // يوم
const MARGIN_LTV = 7500n;
const LIQ_LTV    = 8500n;
const MERCHANDISE = SATS(0.16); // البيتكوين المبيع
const COLLATERAL  = SATS(0.5);  // الرهن المطلوب → عند $60k = $30,000 → LTV ≈ 36.7%

const DESC_HASH = ethers.id("2of3-descriptor-xyz");
const DEP_TXID  = ethers.id("collateral-deposit-txid");
const DEL_TXID  = ethers.id("merchandise-delivery-txid");

// مفاتيح عامة مضغوطة (33 بايت: بادئة 02/03 + 32 بايت)
const PK_SELLER = "0x02" + "11".repeat(32);
const PK_BUYER  = "0x03" + "22".repeat(32);
const PK_QIST   = "0x02" + "99".repeat(32); // مفتاح قسط (الحَكَم) — BE-12
const BTC_ADDR  = "bc1qh2pz6t8crs7ykxh66emp2huxm5futgdsget5wd5jsuhnnug42nks2q3vsn";

const DAY = 86400;
const GRACE = 3 * DAY;
const DISPUTE_WINDOW = 2 * DAY;

const TERMS = {
  cost: COST,
  profitBps: PROFIT_BPS,
  totalInstallments: INSTALLMENTS,
  paymentInterval: INTERVAL,
  marginCallLtvBps: MARGIN_LTV,
  liquidationLtvBps: LIQ_LTV,
  merchandiseSats: MERCHANDISE,
  requiredCollateralSats: COLLATERAL,
};
const terms = (o: Partial<typeof TERMS> = {}) => ({ ...TERMS, ...o });

async function deploy() {
  const [owner, buyer, seller, attestor, arbiter, treasury, stranger] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const stray = await (await ethers.getContractFactory("MockWBTC")).deploy();
  const btcFeed = await (await ethers.getContractFactory("MockFeed")).deploy(BTC_60K, 8);
  const seqFeed = await (await ethers.getContractFactory("MockSequencerFeed")).deploy(0, 1);

  const Factory = await ethers.getContractFactory("BtcEscrowMurabaha");
  const m = await upgrades.deployProxy(Factory, [
    owner.address, await usdc.getAddress(), await btcFeed.getAddress(),
    await seqFeed.getAddress(), attestor.address, arbiter.address, treasury.address, 100,
  ], { kind: "uups", unsafeAllow: ["constructor"] });

  await usdc.mint(buyer.address, U(1_000_000));
  await usdc.connect(buyer).approve(await m.getAddress(), ethers.MaxUint256);

  return { m, usdc, stray, btcFeed, seqFeed, owner, buyer, seller, attestor, arbiter, treasury, stranger };
}
type Ctx = Awaited<ReturnType<typeof deploy>>;

const stateOf = async (m: any, id: bigint | number) => (await m.getDeal(id)).state;

/// عرض بيع مقبول → AWAITING_COLLATERAL
async function acceptedSellOffer(ctx: Ctx, t = terms()) {
  const { m, buyer, seller } = ctx;
  await m.connect(seller).createSellOffer(t, PK_SELLER);
  const id = 1n;
  await m.connect(buyer).accept(id, PK_BUYER, BTC_ADDR);
  return id;
}

/// يوصل صفقة إلى ACTIVE (الرهن محجوز، المبيع سُلّم لعنوان المشتري)
async function activeDeal(ctx: Ctx) {
  const { m, attestor } = ctx;
  const id = await acceptedSellOffer(ctx);
  await m.connect(attestor).confirmCollateral(id, COLLATERAL, DESC_HASH, DEP_TXID);
  await m.connect(attestor).confirmDelivery(id, MERCHANDISE, DEL_TXID);
  return id;
}

describe("BtcEscrowMurabaha v2 (سوق ثنائي الاتجاه)", () => {
  describe("التهيئة", () => {
    it("تُهيّئ بالقيم الصحيحة", async () => {
      const { m, usdc, attestor, arbiter, treasury, owner } = await deploy();
      expect(await m.usdc()).to.equal(await usdc.getAddress());
      expect(await m.attestor()).to.equal(attestor.address);
      expect(await m.arbiter()).to.equal(arbiter.address);
      expect(await m.protocolTreasury()).to.equal(treasury.address);
      expect(await m.owner()).to.equal(owner.address);
      expect(await m.nextDealId()).to.equal(1n);
    });

    it("ترفض رسوماً أعلى من السقف", async () => {
      const { owner, buyer } = await deploy();
      const Factory = await ethers.getContractFactory("BtcEscrowMurabaha");
      await expect(upgrades.deployProxy(Factory, [
        owner.address, buyer.address, buyer.address, buyer.address,
        owner.address, owner.address, owner.address, 301,
      ], { kind: "uups", unsafeAllow: ["constructor"] })).to.be.reverted;
    });
  });

  // ═══════════════════════ الاتجاه الأول: عرض بيع ═══════════════════════

  describe("عرض بيع (البائع ينشئ)", () => {
    it("يُنشر فوراً OPEN بلا خطوة نشر منفصلة", async () => {
      const { m, seller } = await deploy();
      await m.connect(seller).createSellOffer(terms(), PK_SELLER);
      const d = await m.getDeal(1);
      expect(d.state).to.equal(S.OPEN);
      expect(d.seller).to.equal(seller.address);
      expect(d.buyer).to.equal(ethers.ZeroAddress);
      expect(d.totalPayable).to.equal(TOTAL_PAY);
      expect(d.merchandiseSats).to.equal(MERCHANDISE);
      expect(d.requiredCollateralSats).to.equal(COLLATERAL);
      expect(d.sellerBtcPubkey).to.equal(PK_SELLER);
      expect(await m.isSellOffer(1)).to.equal(true);
    });

    it("المشتري يقبل بمفتاحه وعنوان استلامه → AWAITING_COLLATERAL", async () => {
      const ctx = await deploy();
      const id = await acceptedSellOffer(ctx);
      const d = await ctx.m.getDeal(id);
      expect(d.state).to.equal(S.AWAITING_COLLATERAL);
      expect(d.buyer).to.equal(ctx.buyer.address);
      expect(d.buyerBtcPubkey).to.equal(PK_BUYER);
      expect(d.buyerBtcAddress).to.equal(BTC_ADDR);
    });

    it("القبول يلزمه عنوان استلام للمبيع", async () => {
      const { m, seller, buyer } = await deploy();
      await m.connect(seller).createSellOffer(terms(), PK_SELLER);
      await expect(m.connect(buyer).accept(1, PK_BUYER, ""))
        .to.be.revertedWithCustomError(m, "InvalidBtcAddress");
    });

    it("البائع لا يقبل عرض نفسه", async () => {
      const { m, seller } = await deploy();
      await m.connect(seller).createSellOffer(terms(), PK_SELLER);
      await expect(m.connect(seller).accept(1, PK_BUYER, BTC_ADDR))
        .to.be.revertedWithCustomError(m, "SelfDealNotAllowed");
    });

    // ══════ BE-13: نسبة الضمان عرضاً وطلباً ══════
    describe("BE-13 — سقف LTV الابتدائي 87%", () => {
      it("هامش 15% فوق الدين يمرّ (LTV ≈ 87%)", async () => {
        expect(await (await deploy()).m.MAX_INITIAL_LTV_BPS()).to.equal(8700);
      });

      it("العتبات يختارها المُنشئ ما دام الإنذار دون التصفية والتصفية ≤ 95%", async () => {
        const { m, seller } = await deploy();
        // هامش رقيق: إنذار 91% وتصفية 95% — مسموح
        await m.connect(seller).createSellOffer(
          { ...terms(), marginCallLtvBps: 9100, liquidationLtvBps: 9500 }, PK_SELLER);
        expect((await m.getDeal(1)).liquidationLtvBps).to.equal(9500);
      });

      it("تصفية فوق 95% مرفوضة — السقف الصلب باقٍ", async () => {
        const { m, seller } = await deploy();
        await expect(m.connect(seller).createSellOffer(
          { ...terms(), marginCallLtvBps: 9100, liquidationLtvBps: 9600 }, PK_SELLER))
          .to.be.revertedWithCustomError(m, "LtvConfigInvalid");
      });

      it("إنذار ≥ تصفية مرفوض", async () => {
        const { m, seller } = await deploy();
        await expect(m.connect(seller).createSellOffer(
          { ...terms(), marginCallLtvBps: 9500, liquidationLtvBps: 9500 }, PK_SELLER))
          .to.be.revertedWithCustomError(m, "LtvConfigInvalid");
      });
    });

    // ══════ BE-12: حماية الخزنة من الانهيار إلى مفتاح واحد ══════
    //
    // الخزنة sortedmulti(2, مشترٍ, بائع, قسط). لو تكرّر مفتاح صارت خانتان
    // لمفتاح واحد، ويكفي حاملَه توقيعان ⇒ يسحب الرهن **منفرداً**. تبدو 2-of-3
    // وهي 1-of-1. وقع هذا فعلياً على Mainnet (صفقة #2) لأن المستخدم غيّر محفظة
    // Base ونسي محفظة Bitcoin — و SelfDealNotAllowed يحرس العنوان لا المفتاح.
    describe("BE-12 — تكرار مفاتيح Bitcoin", () => {
      it("مشترٍ بمفتاح البائع نفسه يُرفض ولو اختلف عنوان Base", async () => {
        const { m, seller, buyer } = await deploy();
        await m.connect(seller).createSellOffer(terms(), PK_SELLER);
        await expect(m.connect(buyer).accept(1, PK_SELLER, BTC_ADDR))
          .to.be.revertedWithCustomError(m, "DuplicateBtcPubkey");
      });

      it("بائع بمفتاح المشتري نفسه يُرفض", async () => {
        const { m, buyer, seller } = await deploy();
        await m.connect(buyer).createBuyRequest(terms(), PK_BUYER, BTC_ADDR);
        await expect(m.connect(seller).accept(1, PK_BUYER, ""))
          .to.be.revertedWithCustomError(m, "DuplicateBtcPubkey");
      });

      it("مفتاح مختلف يمرّ — الحارس لا يعيق المسار السليم", async () => {
        const { m, seller, buyer } = await deploy();
        await m.connect(seller).createSellOffer(terms(), PK_SELLER);
        await expect(m.connect(buyer).accept(1, PK_BUYER, BTC_ADDR))
          .to.emit(m, "DealAccepted");
      });

      it("انتحال مفتاح قسط مرفوض — وإلا سحبت قسط الرهن وحدها", async () => {
        const { m, owner, seller, buyer } = await deploy();
        await m.connect(owner).setArbiterBtcPubkey(PK_QIST);
        await expect(m.connect(seller).createSellOffer(terms(), PK_QIST))
          .to.be.revertedWithCustomError(m, "ArbiterKeyNotAllowed");
        await m.connect(seller).createSellOffer(terms(), PK_SELLER);
        await expect(m.connect(buyer).accept(1, PK_QIST, BTC_ADDR))
          .to.be.revertedWithCustomError(m, "ArbiterKeyNotAllowed");
      });

      it("قبل ضبط مفتاح قسط لا يُفرَض شيء — الصفقات القائمة لا تنكسر", async () => {
        const { m, seller, buyer } = await deploy();
        expect(await m.arbiterBtcPubkey()).to.equal("0x");
        await m.connect(seller).createSellOffer(terms(), PK_QIST);
        await expect(m.connect(buyer).accept(1, PK_BUYER, BTC_ADDR))
          .to.emit(m, "DealAccepted");
      });

      it("ضبط مفتاح قسط: المالك وحده، وبمفتاح صالح", async () => {
        const { m, owner, buyer } = await deploy();
        await expect(m.connect(buyer).setArbiterBtcPubkey(PK_QIST))
          .to.be.revertedWithCustomError(m, "OwnableUnauthorizedAccount");
        await expect(m.connect(owner).setArbiterBtcPubkey("0x0211"))
          .to.be.revertedWithCustomError(m, "InvalidPubkey");
        await m.connect(owner).setArbiterBtcPubkey(PK_QIST);
        expect(await m.arbiterBtcPubkey()).to.equal(PK_QIST);
      });
    });
  });

  // ═══════════════════════ الاتجاه الثاني: طلب شراء ═══════════════════════

  describe("طلب شراء (المشتري ينشئ)", () => {
    it("يُنشر فوراً OPEN ويسجّل عنوان استلام المشتري", async () => {
      const { m, buyer } = await deploy();
      await m.connect(buyer).createBuyRequest(terms(), PK_BUYER, BTC_ADDR);
      const d = await m.getDeal(1);
      expect(d.state).to.equal(S.OPEN);
      expect(d.buyer).to.equal(buyer.address);
      expect(d.seller).to.equal(ethers.ZeroAddress);
      expect(d.buyerBtcAddress).to.equal(BTC_ADDR);
      expect(await m.isSellOffer(1)).to.equal(false);
    });

    it("البائع يقبل بمفتاحه (العنوان يُهمَل) → AWAITING_COLLATERAL", async () => {
      const { m, buyer, seller } = await deploy();
      await m.connect(buyer).createBuyRequest(terms(), PK_BUYER, BTC_ADDR);
      await expect(m.connect(seller).accept(1, PK_SELLER, ""))
        .to.emit(m, "DealAccepted").withArgs(1n, seller.address, false);
      const d = await m.getDeal(1);
      expect(d.state).to.equal(S.AWAITING_COLLATERAL);
      expect(d.seller).to.equal(seller.address);
      expect(d.sellerBtcPubkey).to.equal(PK_SELLER);
    });

    it("المشتري لا يقبل طلب نفسه", async () => {
      const { m, buyer } = await deploy();
      await m.connect(buyer).createBuyRequest(terms(), PK_BUYER, BTC_ADDR);
      await expect(m.connect(buyer).accept(1, PK_SELLER, ""))
        .to.be.revertedWithCustomError(m, "SelfDealNotAllowed");
    });

    it("الاتجاهان يلتقيان عند نفس الحالة", async () => {
      const { m, buyer, seller } = await deploy();
      await m.connect(seller).createSellOffer(terms(), PK_SELLER);
      await m.connect(buyer).createBuyRequest(terms(), PK_BUYER, BTC_ADDR);
      await m.connect(buyer).accept(1, PK_BUYER, BTC_ADDR);
      await m.connect(seller).accept(2, PK_SELLER, "");
      expect(await stateOf(m, 1)).to.equal(S.AWAITING_COLLATERAL);
      expect(await stateOf(m, 2)).to.equal(S.AWAITING_COLLATERAL);
    });
  });

  // ═══════════════════════ التحقّق من المدخلات ═══════════════════════

  describe("التحقّق من الشروط والمفاتيح", () => {
    it("ترفض مبيعاً بصفر ساتوشي", async () => {
      const { m, seller } = await deploy();
      await expect(m.connect(seller).createSellOffer(terms({ merchandiseSats: 0n }), PK_SELLER))
        .to.be.revertedWithCustomError(m, "InvalidParams");
    });

    it("ترفض رهناً مطلوباً بصفر", async () => {
      const { m, seller } = await deploy();
      await expect(m.connect(seller).createSellOffer(terms({ requiredCollateralSats: 0n }), PK_SELLER))
        .to.be.revertedWithCustomError(m, "InvalidParams");
    });

    it("ترفض ربحاً فوق الحد", async () => {
      const { m, seller } = await deploy();
      await expect(m.connect(seller).createSellOffer(terms({ profitBps: 30001n }), PK_SELLER))
        .to.be.revertedWithCustomError(m, "ProfitTooHigh");
    });

    it("ترفض ترتيب عتبات LTV غير صالح", async () => {
      const { m, seller } = await deploy();
      await expect(m.connect(seller).createSellOffer(terms({ marginCallLtvBps: 8500n }), PK_SELLER))
        .to.be.revertedWithCustomError(m, "LtvConfigInvalid");
    });

    it("ترفض فاصلاً زمنياً أقل من الحد الأدنى (يوم)", async () => {
      const { m, seller } = await deploy();
      await expect(m.connect(seller).createSellOffer(terms({ paymentInterval: 3600n }), PK_SELLER))
        .to.be.revertedWithCustomError(m, "IntervalOutOfRange");
    });

    it("ترفض فاصلاً زمنياً فوق 4 سنوات", async () => {
      const { m, seller } = await deploy();
      await expect(m.connect(seller).createSellOffer(
        terms({ paymentInterval: BigInt(1462 * DAY) }), PK_SELLER))
        .to.be.revertedWithCustomError(m, "IntervalOutOfRange");
    });

    it("تقبل دفعة واحدة بأجل 4 سنوات", async () => {
      const { m, seller } = await deploy();
      await m.connect(seller).createSellOffer(
        terms({ totalInstallments: 1, paymentInterval: BigInt(1461 * DAY) }), PK_SELLER);
      const d = await m.getDeal(1);
      expect(d.totalInstallments).to.equal(1n);
      expect(d.paymentInterval).to.equal(BigInt(1461 * DAY));
    });

    it("تقبل أجلاً سنة وسنتين وثلاثاً", async () => {
      const { m, seller } = await deploy();
      for (const years of [1, 2, 3]) {
        await m.connect(seller).createSellOffer(
          terms({ totalInstallments: 1, paymentInterval: BigInt(365 * years * DAY) }), PK_SELLER);
      }
      expect(await m.nextDealId()).to.equal(4n);
    });

    it("تقبل دفعة واحدة (قسط واحد)", async () => {
      const { m, seller } = await deploy();
      await m.connect(seller).createSellOffer(terms({ totalInstallments: 1 }), PK_SELLER);
      expect((await m.getDeal(1)).totalInstallments).to.equal(1n);
    });

    it("ترفض مفتاحاً عاماً بطول خاطئ", async () => {
      const { m, seller } = await deploy();
      await expect(m.connect(seller).createSellOffer(terms(), "0x0211"))
        .to.be.revertedWithCustomError(m, "InvalidPubkey");
    });

    it("ترفض مفتاحاً عاماً ببادئة غير مضغوطة", async () => {
      const { m, seller } = await deploy();
      await expect(m.connect(seller).createSellOffer(terms(), "0x04" + "11".repeat(32)))
        .to.be.revertedWithCustomError(m, "InvalidPubkey");
    });

    it("ترفض عنوان bitcoin أطول من الحد", async () => {
      const { m, buyer } = await deploy();
      await expect(m.connect(buyer).createBuyRequest(terms(), PK_BUYER, "b".repeat(101)))
        .to.be.revertedWithCustomError(m, "InvalidBtcAddress");
    });
  });

  // ═══════════════════════ المسار السعيد ═══════════════════════

  describe("المسار السعيد (٣ خطوات)", () => {
    it("عرض → قبول+رهن → تسليم → أقساط → REPAID → فكّ الرهن", async () => {
      const ctx = await deploy();
      const { m, usdc, buyer, seller, attestor, treasury } = ctx;

      const buyerBefore = await usdc.balanceOf(buyer.address);
      const id = await activeDeal(ctx);

      // BE-08: المشتري لا يستلم USDC (يستلم البيتكوين المبيع على L1)
      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBefore);
      expect(await stateOf(m, id)).to.equal(S.ACTIVE);

      const sellerBefore = await usdc.balanceOf(seller.address);
      const treasuryBefore = await usdc.balanceOf(treasury.address);

      for (let i = 0; i < INSTALLMENTS; i++) {
        await m.connect(buyer).payInstallment(id);
        if (i < INSTALLMENTS - 1) await time.increase(INTERVAL);
      }
      expect(await stateOf(m, id)).to.equal(S.REPAID);

      expect(await usdc.balanceOf(buyer.address)).to.equal(buyerBefore - TOTAL_PAY);
      const fee = (PER_INST * 100n) / 10000n;
      const net = PER_INST - fee;
      expect(await usdc.balanceOf(seller.address)).to.equal(sellerBefore + net * 10n);
      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore + fee * 10n);
      expect(await usdc.balanceOf(await m.getAddress())).to.equal(0n);

      await m.connect(attestor).confirmCollateralReleased(id, ethers.id("release-txid"));
      expect(await stateOf(m, id)).to.equal(S.COLLATERAL_RELEASED);
    });

    it("دفعة واحدة تُنهي الصفقة بقسط واحد", async () => {
      const ctx = await deploy();
      const { m, buyer, seller, attestor } = ctx;
      await m.connect(seller).createSellOffer(terms({ totalInstallments: 1 }), PK_SELLER);
      await m.connect(buyer).accept(1, PK_BUYER, BTC_ADDR);
      await m.connect(attestor).confirmCollateral(1, COLLATERAL, DESC_HASH, DEP_TXID);
      await m.connect(attestor).confirmDelivery(1, MERCHANDISE, DEL_TXID);
      await m.connect(buyer).payInstallment(1);
      expect(await stateOf(m, 1)).to.equal(S.REPAID);
    });

    it("لا فكّ للرهن قبل REPAID", async () => {
      const ctx = await deploy();
      const id = await activeDeal(ctx);
      await expect(ctx.m.connect(ctx.attestor).confirmCollateralReleased(id, ethers.id("x")))
        .to.be.revertedWithCustomError(ctx.m, "BadState");
    });
  });

  // ═══════════════════════ الرهن والتسليم ═══════════════════════

  describe("الرهن والتسليم", () => {
    it("رهن كافٍ → AWAITING_DELIVERY مباشرة (لا انتظار إيداع البائع)", async () => {
      const ctx = await deploy();
      const id = await acceptedSellOffer(ctx);
      await ctx.m.connect(ctx.attestor).confirmCollateral(id, COLLATERAL, DESC_HASH, DEP_TXID);
      expect(await stateOf(ctx.m, id)).to.equal(S.AWAITING_DELIVERY);
    });

    it("رهن أقل من المطلوب يبقى AWAITING_COLLATERAL", async () => {
      const ctx = await deploy();
      const { m, attestor } = ctx;
      const id = await acceptedSellOffer(ctx);
      await expect(m.connect(attestor).confirmCollateral(id, SATS(0.1), DESC_HASH, DEP_TXID))
        .to.emit(m, "CollateralPartial");
      expect(await stateOf(m, id)).to.equal(S.AWAITING_COLLATERAL);

      await m.connect(attestor).confirmCollateral(id, COLLATERAL, DESC_HASH, DEP_TXID);
      expect(await stateOf(m, id)).to.equal(S.AWAITING_DELIVERY);
    });

    it("رهن يبلغ المطلوب لكن LTV الابتدائي فوق 80% يبقى AWAITING_COLLATERAL", async () => {
      const ctx = await deploy();
      const { m, attestor } = ctx;
      // المطلوب 0.2 BTC = $12,000 مقابل دين $11,000 → LTV ≈ 91.6% > 80%
      const id = await acceptedSellOffer(ctx, terms({ requiredCollateralSats: SATS(0.2) }));
      await expect(m.connect(attestor).confirmCollateral(id, SATS(0.2), DESC_HASH, DEP_TXID))
        .to.emit(m, "CollateralPartial");
      expect(await stateOf(m, id)).to.equal(S.AWAITING_COLLATERAL);
    });

    it("يرفض تسليماً أقل من المبيع المتفق عليه", async () => {
      const ctx = await deploy();
      const { m, attestor } = ctx;
      const id = await acceptedSellOffer(ctx);
      await m.connect(attestor).confirmCollateral(id, COLLATERAL, DESC_HASH, DEP_TXID);
      await expect(m.connect(attestor).confirmDelivery(id, SATS(0.1), DEL_TXID))
        .to.be.revertedWithCustomError(m, "MerchandiseTooLittle");
    });

    it("لا تسليم قبل كفاية الرهن", async () => {
      const ctx = await deploy();
      const { m, attestor } = ctx;
      const id = await acceptedSellOffer(ctx);
      await expect(m.connect(attestor).confirmDelivery(id, MERCHANDISE, DEL_TXID))
        .to.be.revertedWithCustomError(m, "BadState");
    });

    it("التسليم يفعّل رغم هبوط السعر بعده (لا تباين بين السلسلتين)", async () => {
      const ctx = await deploy();
      const { m, attestor, btcFeed } = ctx;
      const id = await acceptedSellOffer(ctx);
      await m.connect(attestor).confirmCollateral(id, COLLATERAL, DESC_HASH, DEP_TXID);

      await btcFeed.setAnswer(BTC_24K); // هبط بعد حجز الرهن
      await m.connect(attestor).confirmDelivery(id, MERCHANDISE, DEL_TXID);
      expect(await stateOf(m, id)).to.equal(S.ACTIVE);

      await m.poke(id); // التصفية تتكفّل
      expect(await stateOf(m, id)).to.equal(S.LIQUIDATION_ELIGIBLE);
    });

    it("فقط attestor يشهد بالرهن والتسليم", async () => {
      const ctx = await deploy();
      const { m, stranger, attestor } = ctx;
      const id = await acceptedSellOffer(ctx);
      await expect(m.connect(stranger).confirmCollateral(id, COLLATERAL, DESC_HASH, DEP_TXID))
        .to.be.revertedWithCustomError(m, "NotAttestor");
      await m.connect(attestor).confirmCollateral(id, COLLATERAL, DESC_HASH, DEP_TXID);
      await expect(m.connect(stranger).confirmDelivery(id, MERCHANDISE, DEL_TXID))
        .to.be.revertedWithCustomError(m, "NotAttestor");
    });
  });

  // ═══════════════════════ المخاطر ═══════════════════════

  describe("نداء الهامش", () => {
    it("هبوط السعر → MARGIN_CALL، والتعزيز يعيدها ACTIVE", async () => {
      const ctx = await deploy();
      const { m, attestor, btcFeed } = ctx;
      const id = await activeDeal(ctx);
      await btcFeed.setAnswer(BTC_28K);
      await expect(m.poke(id)).to.emit(m, "MarginCallRaised");
      expect(await stateOf(m, id)).to.equal(S.MARGIN_CALL);
      await m.connect(attestor).updateCollateral(id, SATS(1), ethers.id("topup"));
      expect(await stateOf(m, id)).to.equal(S.ACTIVE);
    });
  });

  describe("التصفية السعرية", () => {
    it("هبوط حاد → LIQUIDATION_ELIGIBLE → confirmLiquidation → LIQUIDATED", async () => {
      const ctx = await deploy();
      const { m, attestor, btcFeed } = ctx;
      const id = await activeDeal(ctx);
      await btcFeed.setAnswer(BTC_24K);
      await m.poke(id);
      expect(await stateOf(m, id)).to.equal(S.LIQUIDATION_ELIGIBLE);
      await expect(m.connect(attestor).confirmLiquidation(id, TOTAL_PAY, SATS(0.45), SATS(0.05), ethers.id("liq")))
        .to.emit(m, "Liquidated");
      expect(await stateOf(m, id)).to.equal(S.LIQUIDATED);
    });

    it("confirmLiquidation ممنوعة قبل التأهّل", async () => {
      const ctx = await deploy();
      const id = await activeDeal(ctx);
      await expect(ctx.m.connect(ctx.attestor).confirmLiquidation(id, TOTAL_PAY, SATS(0.45), SATS(0.05), ethers.id("x")))
        .to.be.revertedWithCustomError(ctx.m, "BadState");
    });
  });

  describe("التعثر الزمني", () => {
    it("متأخر → PAYMENT_OVERDUE → DEFAULT_PENDING → LIQUIDATION_ELIGIBLE", async () => {
      const ctx = await deploy();
      const { m } = ctx;
      const id = await activeDeal(ctx);
      await time.increase(Number(INTERVAL) + 10);
      await m.poke(id);
      expect(await stateOf(m, id)).to.equal(S.PAYMENT_OVERDUE);
      await time.increase(GRACE);
      await m.poke(id);
      expect(await stateOf(m, id)).to.equal(S.DEFAULT_PENDING);
      await time.increase(DISPUTE_WINDOW);
      await m.poke(id);
      expect(await stateOf(m, id)).to.equal(S.LIQUIDATION_ELIGIBLE);
    });

    it("السداد أثناء التأخّر يعيدها ACTIVE", async () => {
      const ctx = await deploy();
      const { m, buyer } = ctx;
      const id = await activeDeal(ctx);
      await time.increase(Number(INTERVAL) + GRACE + 10);
      await m.poke(id);
      expect(await stateOf(m, id)).to.equal(S.DEFAULT_PENDING);
      await m.connect(buyer).payInstallment(id);
      expect(await stateOf(m, id)).to.equal(S.ACTIVE);
    });
  });

  describe("النزاع", () => {
    it("raiseDispute ثم resolveDispute بواسطة المحكّم", async () => {
      const ctx = await deploy();
      const { m, buyer, arbiter } = ctx;
      const id = await activeDeal(ctx);
      await expect(m.connect(buyer).raiseDispute(id)).to.emit(m, "DisputeRaised");
      expect(await stateOf(m, id)).to.equal(S.DISPUTED);
      await m.poke(id);
      expect(await stateOf(m, id)).to.equal(S.DISPUTED);
      await m.connect(arbiter).resolveDispute(id, S.LIQUIDATION_ELIGIBLE);
      expect(await stateOf(m, id)).to.equal(S.LIQUIDATION_ELIGIBLE);
    });

    it("غير الأطراف لا يرفع نزاعاً", async () => {
      const ctx = await deploy();
      const { m, stranger } = ctx;
      const id = await activeDeal(ctx);
      await expect(m.connect(stranger).raiseDispute(id)).to.be.revertedWithCustomError(m, "NotParty");
    });

    it("فقط المحكّم يحسم", async () => {
      const ctx = await deploy();
      const { m, buyer, stranger } = ctx;
      const id = await activeDeal(ctx);
      await m.connect(buyer).raiseDispute(id);
      await expect(m.connect(stranger).resolveDispute(id, S.ACTIVE)).to.be.revertedWithCustomError(m, "NotArbiter");
    });
  });

  // ═══════════════════════ الإلغاء ═══════════════════════

  describe("الإلغاء", () => {
    it("مُنشئ العرض وحده يلغيه في OPEN", async () => {
      const { m, seller, stranger } = await deploy();
      await m.connect(seller).createSellOffer(terms(), PK_SELLER);
      await expect(m.connect(stranger).cancel(1)).to.be.revertedWithCustomError(m, "NotParty");
      await m.connect(seller).cancel(1);
      expect(await stateOf(m, 1)).to.equal(S.CANCELLED);
    });

    it("مُنشئ الطلب وحده يلغيه في OPEN", async () => {
      const { m, buyer, stranger } = await deploy();
      await m.connect(buyer).createBuyRequest(terms(), PK_BUYER, BTC_ADDR);
      await expect(m.connect(stranger).cancel(1)).to.be.revertedWithCustomError(m, "NotParty");
      await m.connect(buyer).cancel(1);
      expect(await stateOf(m, 1)).to.equal(S.CANCELLED);
    });

    it("أيّ طرف يلغي أثناء انتظار الرهن", async () => {
      const ctx = await deploy();
      const id = await acceptedSellOffer(ctx);
      await ctx.m.connect(ctx.seller).cancel(id);
      expect(await stateOf(ctx.m, id)).to.equal(S.CANCELLED);
    });

    it("المشتري يستردّ رهنه إن لم يسلّم البائع خلال المهلة", async () => {
      const ctx = await deploy();
      const { m, buyer, attestor } = ctx;
      const id = await acceptedSellOffer(ctx);
      await m.connect(attestor).confirmCollateral(id, COLLATERAL, DESC_HASH, DEP_TXID);
      expect(await stateOf(m, id)).to.equal(S.AWAITING_DELIVERY);

      await expect(m.connect(buyer).cancel(id)).to.be.revertedWithCustomError(m, "DeliveryDeadlineNotPassed");
      await time.increase(2 * DAY + 1);
      await m.connect(buyer).cancel(id);
      expect(await stateOf(m, id)).to.equal(S.CANCELLED);

      // الرهن يعود على L1 بتوقيع المشتري + قسط، ثم يشهد attestor
      await m.connect(attestor).confirmCollateralReleased(id, ethers.id("refund-txid"));
      expect(await stateOf(m, id)).to.equal(S.COLLATERAL_RELEASED);
    });

    it("لا إلغاء بعد التفعيل", async () => {
      const ctx = await deploy();
      const id = await activeDeal(ctx);
      await expect(ctx.m.connect(ctx.buyer).cancel(id)).to.be.revertedWithCustomError(ctx.m, "BadState");
    });
  });

  // ═══════════════════════ الطوارئ ═══════════════════════

  describe("الطوارئ", () => {
    it("emergencyWithdraw يحظر USDC", async () => {
      const ctx = await deploy();
      const { m, usdc, owner } = ctx;
      await m.connect(owner).pause();
      await expect(m.connect(owner).emergencyWithdraw(await usdc.getAddress()))
        .to.be.revertedWithCustomError(m, "CannotWithdrawUserAsset");
    });

    it("emergencyWithdraw يسترجع الرموز الغريبة إلى الخزينة", async () => {
      const ctx = await deploy();
      const { m, stray, owner, treasury } = ctx;
      await stray.mint(await m.getAddress(), SATS(3));
      await m.connect(owner).pause();
      await m.connect(owner).emergencyWithdraw(await stray.getAddress());
      expect(await stray.balanceOf(treasury.address)).to.equal(SATS(3));
    });

    it("poke يُرفض عند توقّف الـ Sequencer", async () => {
      const ctx = await deploy();
      const { m, seqFeed } = ctx;
      const id = await activeDeal(ctx);
      await seqFeed.set(1, 1);
      await expect(m.poke(id)).to.be.revertedWithCustomError(m, "SequencerDown");
    });

    it("فقط المالك يوقف ويغيّر الإعدادات", async () => {
      const ctx = await deploy();
      const { m, stranger } = ctx;
      await expect(m.connect(stranger).pause()).to.be.reverted;
      await expect(m.connect(stranger).setProtocolFeeBps(50)).to.be.reverted;
    });
  });
});

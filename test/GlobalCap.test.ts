import { expect } from "chai";
import { ethers, upgrades, artifacts } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployScenario, runScenario, recomputeCustody, OPS,
  U, BTC, E, INTERVAL, GRACE, ETH_FEED, BTC_FEED,
} from "./helpers/custodyScenario";
import { linkedFactory, UPG, withLibErrors } from "./helpers/linked";

/**
 * السقف الإجمالي — Build 22 (docs/global-cap-design.md). **مفعّل** على التنفيذ الفعلي.
 * قرار المالك: إجمالي 20,000 · التزامات 15,000 (الاحتياطي = 5,000 للإنقاذ) · عروض غير مباعة 5,000.
 * الأسعار في الاختبار: BTC = $60,000 · ETH = $3,000.
 */
const GLOBAL = U(20_000);
const COMMIT = U(15_000);
const OFFERS = U(5_000);
const Q_BTC = 60000n * 10n ** 6n;
const Q_ETH = 3000n * 10n ** 6n;
const ZERO = ethers.ZeroAddress;

async function deploy() {
  const s = await deployScenario();
  return { ...s, g: await withLibErrors(s.m) as any };
}
type Ctx = Awaited<ReturnType<typeof deploy>>;
const caps = (c: Ctx, g = GLOBAL, k = COMMIT, o = OFFERS) => c.m.connect(c.owner).setCustodyCaps(g, k, o);
const custodyOf = async (c: Ctx, t: string) => (await c.m.offerCustody(t)) + (await c.m.collateralCustody(t));
/** التبرّعات تُعرض منفصلة خارج السلسلة (أُزيلت untrackedBalance من العقد — حدّ الحجم) */
const untracked = async (c: Ctx, t: string) => {
  const bal = t === ZERO ? await ethers.provider.getBalance(c.mAddr) : await c.wbtc.balanceOf(c.mAddr);
  const owed = (await custodyOf(c, t)) + (t === ZERO ? await c.m.totalPendingETH() : 0n);
  return bal - owed;
};
async function btcOffer(c: Ctx, who: any, amount: bigint, colToken?: string) {
  return c.m.connect(who).createOffer(c.wAddr, colToken ?? c.wAddr, await c.usdc.getAddress(), amount, 1000, 1, 12, INTERVAL, 0, 12000, false);
}
const anyUint = () => (v: bigint) => typeof v === "bigint";

describe("GlobalCap — سقف إجمالي صارم لكل أموال العقد (Build 22)", () => {

  it("#1 حدّ العروض مشترك بين البائعين: آخر عرض يتجاوز 5,000 يُرفض", async () => {
    const c = await deploy(); await caps(c);
    await btcOffer(c, c.seller,  BTC(0.05)); // $3,000
    await btcOffer(c, c.seller2, BTC(0.03)); // $1,800 ⇒ $4,800
    expect(await c.m.totalExposureUSDC()).to.equal(U(4_800)); // كلها عروض هنا
    await expect(btcOffer(c, c.seller2, BTC(0.004))) // $240 ⇒ $5,040
      .to.be.revertedWithCustomError(c.g, "OfferCapExceeded").withArgs(U(5_040), OFFERS);
  });

  it("#1b حدّ الالتزامات مشترك بين المشترين: الشراء الذي يتجاوز 15,000 يُرفض", async () => {
    const c = await deploy(); await caps(c);
    await btcOffer(c, c.seller, BTC(0.08));                                      // $4,800
    await c.m.connect(c.buyer).buy(1, BTC(0.08), BTC(0.13), Q_BTC, 12, false);    // ضمان $7,800
    await btcOffer(c, c.seller2, BTC(0.08));                                     // ⇒ $12,600
    await expect(c.m.connect(c.buyer2).buy(2, BTC(0.08), BTC(0.13), Q_BTC, 12, false)) // ⇒ $15,600
      .to.be.revertedWithCustomError(c.g, "GlobalCapExceeded").withArgs(U(15_600), COMMIT);
  });

  it("#2 increaseOffer فوق حدّ العروض يُرفض", async () => {
    const c = await deploy(); await caps(c);
    await btcOffer(c, c.seller, BTC(0.08)); // $4,800
    await expect(c.m.connect(c.seller).increaseOffer(1, BTC(0.004))) // ⇒ $5,040
      .to.be.revertedWithCustomError(c.g, "OfferCapExceeded");
  });

  it("#3 buy على الصافي: المبيع يخرج والضمان يدخل", async () => {
    const c = await deploy(); await caps(c, GLOBAL, U(7_000), OFFERS);
    await btcOffer(c, c.seller, BTC(0.08)); // $4,800
    await expect(c.m.connect(c.buyer).buy(1, BTC(0.08), BTC(0.13), Q_BTC, 12, false)) // ضمان $7,800
      .to.be.revertedWithCustomError(c.g, "GlobalCapExceeded").withArgs(U(7_800), U(7_000));
    await caps(c);
    await c.m.connect(c.buyer).buy(1, BTC(0.08), BTC(0.13), Q_BTC, 12, false);
    expect(await c.m.totalExposureUSDC()).to.equal(U(7_800)); // الضمان وحده — لا العرض المُباع
  });

  it("#4 لا عدّ مزدوج: التصفية إلى ETH المعلّق لا تغيّر الإجمالي، والسحب يُنقصه", async () => {
    const c = await deploy();
    await c.m.connect(c.seller).createOffer(ZERO, ZERO, await c.usdc.getAddress(), 0, 1000, 1, 12, INTERVAL, 0, 12000, false, { value: E("1") });
    await c.m.connect(c.buyer).buy(1, E("1"), 0, Q_ETH, 12, false, { value: E("1.5") });
    const before = await c.m.totalExposureUSDC();
    await time.increase(Number(INTERVAL) + GRACE + 1);
    await c.m.connect(c.stranger).liquidatePositionPublic(1);
    expect(await custodyOf(c, ZERO)).to.equal(0n);
    expect(await c.m.totalExposureUSDC()).to.equal(before);
    const pend = await c.m.pendingETH(c.seller.address);
    await c.m.connect(c.seller).withdrawETH();
    expect(await c.m.totalExposureUSDC()).to.equal(before - (pend * 3000n) / 10n ** 12n);
  });

  it("#5 التبرّع لا يُحسب في الإجمالي ويظهر منفصلاً", async () => {
    const c = await deploy();
    await btcOffer(c, c.seller, BTC(0.01));
    const before = await c.m.totalExposureUSDC();
    await c.wbtc.connect(c.buyer).transfer(c.mAddr, BTC(1));
    await c.stranger.sendTransaction({ to: c.mAddr, value: E("5") });
    expect(await c.m.totalExposureUSDC()).to.equal(before);
    expect(await untracked(c, c.wAddr)).to.equal(BTC(1));
    expect(await untracked(c, ZERO)).to.equal(E("5"));
  });

  it("#6 ارتفاع السعر فوق السقف: الجديد مرفوض والخروج كله يعمل", async () => {
    const c = await deploy(); await caps(c);
    await btcOffer(c, c.seller, BTC(0.05));
    await c.m.connect(c.buyer).buy(1, BTC(0.05), BTC(0.075), Q_BTC, 12, false); // ضمان $4,500
    await btcOffer(c, c.seller2, BTC(0.06));                                  // ⇒ $8,100
    await c.btcFeed.setAnswer(BTC_FEED * 3n);                                  // ⇒ $24,300 > 20,000
    await expect(btcOffer(c, c.seller, BTC(0.001)))
      .to.be.revertedWithCustomError(c.g, "GlobalCapExceeded").withArgs(anyUint(), GLOBAL);
    await c.m.connect(c.buyer).payInstallment(1);
    await c.m.connect(c.seller2).decreaseOffer(2, BTC(0.01));
    await c.m.connect(c.seller2).cancelOffer(2);
    await c.m.connect(c.buyer).withdrawExcessCollateral(1, BTC(0.01));
    await c.m.connect(c.buyer).earlyRepayCash(1);
    expect(await c.m.totalExposureUSDC()).to.equal(0n);
  });

  it("#7 مغذٍّ متقادم: الإيداع مرفوض (fail-closed)، والخروج بلا سعر يعمل", async () => {
    const c = await deploy(); await caps(c);
    await btcOffer(c, c.seller, BTC(0.05));
    await c.m.connect(c.buyer).buy(1, BTC(0.05), BTC(0.075), Q_BTC, 12, false);
    await btcOffer(c, c.seller2, BTC(0.02));
    await c.btcFeed.setStale(7200);
    await expect(c.m.connect(c.seller).createOffer(ZERO, ZERO, await c.usdc.getAddress(), 0, 1000, 1, 12, INTERVAL, 0, 12000, false, { value: E("0.1") }))
      .to.be.revertedWithCustomError(c.g, "StalePrice");
    await c.m.connect(c.buyer).payInstallment(1);
    await c.m.connect(c.seller2).cancelOffer(2);
    await c.m.connect(c.buyer).earlyRepayCash(1);
  });

  it("#7b تعطّل ثم عودة: السداد أثناء التعطّل يرفع HF، والتعزيز يعود بعد العودة", async () => {
    const c = await deploy(); await caps(c);
    await btcOffer(c, c.seller, BTC(0.05), ZERO);
    await c.m.connect(c.buyer).buy(1, BTC(0.05), 0, Q_BTC, 12, false, { value: E("1.5") });
    const hf0 = await c.m.healthFactor(1);
    await c.ethFeed.setStale(7200);
    await expect(c.m.connect(c.buyer).addCollateral(1, 0, { value: E("0.1") }))
      .to.be.revertedWithCustomError(c.g, "StalePrice");
    await expect(c.m.connect(c.stranger).liquidatePositionPublic(1)).to.be.reverted;
    for (let i = 0; i < 3; i++) await c.m.connect(c.buyer).payInstallment(1);
    await c.ethFeed.setAnswer(ETH_FEED);
    expect(await c.m.healthFactor(1)).to.be.greaterThan(hf0);
    await c.m.connect(c.buyer).addCollateral(1, 0, { value: E("0.1") });
  });

  it("#8 احتياطي الإنقاذ داخل السقف الصارم", async () => {
    const c = await deploy(); await caps(c);
    // مركز #1: بيع cbBTC بضمان ETH — دين $3,234، ضمان 1.5 ETH ($4,500)
    await btcOffer(c, c.seller, BTC(0.05), ZERO);
    await c.m.connect(c.buyer).buy(1, BTC(0.05), 0, Q_BTC, 12, false, { value: E("1.5") });
    // مركز #2: ضمان cbBTC $9,000 ⇒ إجمالي $13,500
    await btcOffer(c, c.seller2, BTC(0.08));
    await c.m.connect(c.buyer2).buy(2, BTC(0.08), BTC(0.15), Q_BTC, 12, false);
    await c.ethFeed.setAnswer(240_000_000_000n);          // ETH $2,400 ⇒ ضمان #1 $3,600، HF ≈ 111%
    await btcOffer(c, c.seller2, BTC(0.035));             // $2,100 ⇒ إجمالي $14,700 ≤ 15,000
    expect(await c.m.totalExposureUSDC()).to.equal(U(14_700));

    // (أ) التزام جديد فوق 15,000 ⇒ مرفوض
    await expect(btcOffer(c, c.seller2, BTC(0.01)))      // ⇒ $15,300
      .to.be.revertedWithCustomError(c.g, "GlobalCapExceeded").withArgs(U(15_300), COMMIT);
    // (ب) إنقاذ داخل الاحتياطي حتى HF ≤ 150% ⇒ مسموح ($15,420، HF ≈ 134%)
    await c.m.connect(c.buyer).addCollateral(1, 0, { value: E("0.3") });
    // (ج) ركن فوق 150% داخل الاحتياطي ⇒ مرفوض ($16,140، HF ≈ 156%)
    await expect(c.m.connect(c.buyer).addCollateral(1, 0, { value: E("0.3") }))
      .to.be.revertedWithCustomError(c.g, "GlobalCapExceeded").withArgs(U(16_140), COMMIT);
    // (د) فوق 20,000 مرفوض دائماً حتى للإنقاذ
    await c.btcFeed.setAnswer((BTC_FEED * 3n) / 2n);      // BTC $90,000 ⇒ $13,500 + $3,150
    await c.ethFeed.setAnswer(195_000_000_000n);          // ETH $1,950 ⇒ ضمان #1 $3,510، HF ≈ 108.5%
    await expect(c.m.connect(c.buyer).addCollateral(1, 0, { value: E("0.3") }))
      .to.be.revertedWithCustomError(c.g, "GlobalCapExceeded").withArgs(anyUint(), GLOBAL);
  });

  it("#8b ضغط: 3 مراكز تبلغ HF 105% معاً — الاحتياطي 5,000 يرفع الثلاثة إلى 150%", async () => {
    const c = await deploy(); await caps(c);
    const usdc = await c.usdc.getAddress();
    const buyers = [c.buyer, c.buyer2, c.buyer];
    for (let i = 0; i < 3; i++) {
      // عرض لكل مركز (حدّ العروض 5,000 يمنع عرضاً واحداً كبيراً) — دين ≈ $4,000 لكل مركز
      await c.m.connect(c.seller).createOffer(c.wAddr, ZERO, usdc, BTC(0.0618), 1000, 1, 12, INTERVAL, 0, 12000, false);
      const id = BigInt(i * 1 + 1);
      const [, , req] = await c.m.estimatePurchase(id, BTC(0.0618), 12);  // ضمان 120% بالضبط
      await c.m.connect(buyers[i]).buy(id, BTC(0.0618), 0, Q_BTC, 12, false, { value: (req * 10n ** 18n) / (3000n * 10n ** 6n) + 1n });
    }
    await btcOffer(c, c.seller2, BTC(0.01));                     // عرض غير مباع $600
    const exp0 = await c.m.totalExposureUSDC();
    expect(exp0).to.be.lte(COMMIT);                                // ≈ $14,990
    await c.ethFeed.setAnswer(262_500_000_000n);                   // ETH $2,625 ⇒ HF ≈ 105% للثلاثة
    const price = 2625n * 10n ** 6n;
    const topUp = async (id: number, hfBps: bigint) => {
      const debt = await c.m.getRemainingDebt(id);
      const col  = (await c.m.getPosition(id)).collateralAmount;
      const want = (debt * hfBps / 10000n) * 10n ** 18n / price + 1n;
      return want > col ? want - col : 0n;
    };
    for (const id of [1, 2, 3]) {
      const who = (await c.m.getPosition(id)).buyer === c.buyer.address ? c.buyer : c.buyer2;
      await c.m.connect(who).addCollateral(id, 0, { value: await topUp(id, 15000n) });
      expect(await c.m.healthFactor(id)).to.be.gte(14_990n);
    }
    const exp1 = await c.m.totalExposureUSDC();
    expect(exp1).to.be.lte(GLOBAL);                                // ≈ $18,591
    console.log(`      الإجمالي: قبل الهبوط ${Number(exp0) / 1e6} · بعد إنقاذ الثلاثة إلى 150% ${Number(exp1) / 1e6}`);
    // ركن إضافي فوق 150% ⇒ مرفوض
    await expect(c.m.connect(c.buyer).addCollateral(1, 0, { value: E("0.2") }))
      .to.be.revertedWithCustomError(c.g, "GlobalCapExceeded").withArgs(anyUint(), COMMIT);
  });

  it("#9 الإعداد: (0,0,0) معطّل · للمالك فقط · رفض كل تركيبة متناقضة", async () => {
    const c = await deploy();
    expect(await c.m.globalCapUSDC()).to.equal(0n);
    await btcOffer(c, c.seller, BTC(5)); // $300,000 — لا حدّ
    await expect(c.m.connect(c.stranger).setCustodyCaps(GLOBAL, COMMIT, OFFERS))
      .to.be.revertedWithCustomError(c.g, "OwnableUnauthorizedAccount");
    for (const [g, k, o] of [[GLOBAL, GLOBAL + 1n, OFFERS], [0n, COMMIT, 0n], [0n, 0n, OFFERS], [GLOBAL, COMMIT, COMMIT + 1n]]) {
      await expect(c.m.connect(c.owner).setCustodyCaps(g, k, o)).to.be.revertedWithCustomError(c.g, "InvalidParams");
    }
    await expect(caps(c)).to.emit(c.m, "CustodyCapsSet").withArgs(GLOBAL, COMMIT, OFFERS);
    await expect(c.m.connect(c.owner).setCustodyCaps(0n, 0n, 0n)).to.emit(c.m, "CustodyCapsSet");
  });

  it("#9b (global>0, commitment=0) يوقف الالتزامات ولا يعطّل السقف — CAP-V2-01 / CAP-V3-02", async () => {
    const c = await deploy(); await caps(c);
    // CAP-V3-02: يُترك في العرض كمية متاحة حتى يصل الشراء الثاني إلى فحص السقف لا فحص الكمية
    await btcOffer(c, c.seller, BTC(0.05), ZERO);
    await c.m.connect(c.buyer).buy(1, BTC(0.04), 0, Q_BTC, 12, false, { value: E("1.2") });
    await c.m.connect(c.owner).setCustodyCaps(GLOBAL, 0n, 0n);
    await expect(btcOffer(c, c.seller2, BTC(0.3334)))   // يتجاوز الصارم ⇒ الصارم أولاً
      .to.be.revertedWithCustomError(c.g, "GlobalCapExceeded").withArgs(anyUint(), GLOBAL);
    await expect(btcOffer(c, c.seller2, BTC(0.001))).to.be.revertedWithCustomError(c.g, "NewCommitmentsPaused");
    await expect(c.m.connect(c.buyer2).buy(1, BTC(0.005), 0, Q_BTC, 12, false, { value: E("0.2") }))
      .to.be.revertedWithCustomError(c.g, "NewCommitmentsPaused");
    await c.ethFeed.setAnswer(240_000_000_000n);           // HF ≈ 111%
    await c.m.connect(c.buyer).addCollateral(1, 0, { value: E("0.3") }); // إنقاذ ⇒ HF ≈ 139%
    await c.m.connect(c.buyer).earlyRepayCash(1);          // والخروج كذلك
  });

  it("#10 الثابت I1 بعد كل معاملة (مولّد السيناريوهات، 16 مساراً)", async () => {
    const c = await deploy();
    const ok = await runScenario(c, 20261001, 120, async () => {
      expect(await custodyOf(c, ZERO)).to.equal(await recomputeCustody(c, ZERO));
      expect(await custodyOf(c, c.wAddr)).to.equal(await recomputeCustody(c, c.wAddr));
      expect(await c.m.accountingFault()).to.equal(false);
    });
    for (const op of OPS) expect(ok[op], op).to.be.greaterThan(0);
  });

  describe("#11 الترحيل من Build 21 (مصدر مطابق للتنفيذ الحي 0x0C01…83A7)", () => {
    async function legacy() {
      const [owner, seller, buyer, stranger] = await ethers.getSigners();
      const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
      const wbtc = await (await ethers.getContractFactory("MockWBTC")).deploy();
      const ef = await (await ethers.getContractFactory("MockFeed")).deploy(ETH_FEED, 8);
      const bf = await (await ethers.getContractFactory("MockFeed")).deploy(BTC_FEED, 8);
      const p: any = await upgrades.deployProxy(await ethers.getContractFactory("MurabahaV6Build21"),
        [await usdc.getAddress(), await wbtc.getAddress(), await ef.getAddress(), await bf.getAddress(), owner.address, owner.address],
        { kind: "uups", unsafeAllow: ["constructor"] });
      const pa = await p.getAddress(), w = await wbtc.getAddress(), u = await usdc.getAddress();
      for (const a of [seller, buyer]) { await wbtc.mint(a.address, BTC(5)); await usdc.mint(a.address, U(100_000));
        await wbtc.connect(a).approve(pa, ethers.MaxUint256); await usdc.connect(a).approve(pa, ethers.MaxUint256); }
      return { p, pa, w, u, wbtc, owner, seller, buyer, stranger };
    }
    const upgradeAtomic = async (p: any, signer: any) =>
      upgrades.upgradeProxy(p, await linkedFactory("MurabahaV6", signer), { ...UPG, call: { fn: "initializeV3", args: [GLOBAL, COMMIT, OFFERS] } });

    it("حالة مركّبة: مراكز ETH وcbBTC مفتوحة + ETH معلّق للبائع والخزينة + عرض ملغى", async () => {
      const L = await legacy();
      await L.p.connect(L.seller).createOffer(ZERO, ZERO, L.u, 0, 1000, 1, 12, INTERVAL, 0, 12000, false, { value: E("2") });
      await L.p.connect(L.seller).createOffer(L.w, L.w, L.u, BTC(0.1), 1000, 1, 12, INTERVAL, 0, 12000, false);
      await L.p.connect(L.seller).createOffer(L.w, L.w, L.u, BTC(0.02), 1000, 1, 12, INTERVAL, 0, 12000, false);
      await L.p.connect(L.seller).cancelOffer(3);
      await L.p.connect(L.buyer).buy(1, E("0.5"), 0, Q_ETH, 12, false, { value: E("0.8") });
      await L.p.connect(L.buyer).buy(1, E("0.5"), 0, Q_ETH, 12, false, { value: E("0.8") });
      await L.p.connect(L.buyer).buy(2, BTC(0.05), BTC(0.07), Q_BTC, 12, false);
      await time.increase(GRACE + 3600);
      await L.p.connect(L.stranger).liquidatePositionPublic(1);
      const pendBefore = await L.p.totalPendingETH();
      expect(pendBefore).to.be.greaterThan(0n);

      await upgrades.validateUpgrade(L.p, await linkedFactory("MurabahaV6"), { kind: "uups", ...UPG });
      const up: any = await upgradeAtomic(L.p, L.owner);
      expect(await up.offerCustody(ZERO)).to.equal(E("1"));                // العرض #1 المتبقي
      expect(await up.collateralCustody(ZERO)).to.equal(E("0.8"));         // ضمان المركز #2
      expect(await up.offerCustody(L.w)).to.equal(BTC(0.05));              // العرض #2 المتبقي
      expect(await up.collateralCustody(L.w)).to.equal(BTC(0.07));         // ضمان المركز #3
      expect(await up.totalPendingETH()).to.equal(pendBefore);
      expect(await up.accountingFault()).to.equal(false);
      expect(await up.globalCapUSDC()).to.equal(GLOBAL);
      await expect(up.connect(L.owner).initializeV3(GLOBAL, COMMIT, OFFERS)).to.be.reverted;
    });

    it("#11c CAP-V2-02: صلاحية initializeV3 معزولة عن صلاحية الترقية", async () => {
      const L = await legacy();
      const up: any = await upgrades.upgradeProxy(L.p, await linkedFactory("MurabahaV6", L.owner), UPG);
      const g = await withLibErrors(up);
      await expect(up.connect(L.stranger).initializeV3(GLOBAL, COMMIT, OFFERS))
        .to.be.revertedWithCustomError(g, "OwnableUnauthorizedAccount").withArgs(L.stranger.address);
      await up.connect(L.owner).initializeV3(GLOBAL, COMMIT, OFFERS);
      expect(await up.globalCapUSDC()).to.equal(GLOBAL);
      await expect(up.connect(L.owner).initializeV3(GLOBAL, COMMIT, OFFERS))
        .to.be.revertedWithCustomError(g, "InvalidInitialization");
    });

    it("initializeV3 ترفض التركيبات المتناقضة", async () => {
      const L = await legacy();
      const up: any = await upgrades.upgradeProxy(L.p, await linkedFactory("MurabahaV6", L.owner), UPG);
      const g = await withLibErrors(up);
      await expect(up.connect(L.owner).initializeV3(0n, COMMIT, 0n)).to.be.revertedWithCustomError(g, "InvalidParams");
      await expect(up.connect(L.owner).initializeV3(GLOBAL, GLOBAL + 1n, OFFERS)).to.be.revertedWithCustomError(g, "InvalidParams");
      await expect(up.connect(L.owner).initializeV3(GLOBAL, COMMIT, COMMIT + 1n)).to.be.revertedWithCustomError(g, "InvalidParams");
    });

    it("tokenList مكرّرة في الحالة القديمة (خلل Build 21) ⇒ الترقية الذرّية تُرفض", async () => {
      const L = await legacy();
      await L.p.connect(L.owner).removeSupportedToken(L.w);
      const f2 = await (await ethers.getContractFactory("MockFeed")).deploy(BTC_FEED, 8);
      await L.p.connect(L.owner).addSupportedToken(L.w, await f2.getAddress(), 8, false);
      expect((await L.p.getSupportedTokens()).length).to.equal(4); // يثبت الخلل في الكود الحي
      await expect(upgradeAtomic(L.p, L.owner)).to.be.reverted;
    });
  });

  it("#12 رمز مُطفأ بعهدة قائمة يبقى محسوباً", async () => {
    const c = await deploy();
    await btcOffer(c, c.seller, BTC(0.1));
    const before = await c.m.totalExposureUSDC();
    await c.m.connect(c.owner).removeSupportedToken(c.wAddr);
    expect(await c.m.totalExposureUSDC()).to.equal(before);
  });

  it("#13 إعادة تفعيل رمز: لا تكرار ولا تضاعف · العشريات ثابتة · تغيير المغذّي معلَن", async () => {
    const c = await deploy();
    await btcOffer(c, c.seller, BTC(0.1));
    const before = await c.m.totalExposureUSDC();
    const n = (await c.m.getSupportedTokens()).length;
    await c.m.connect(c.owner).removeSupportedToken(c.wAddr);
    await expect(c.m.connect(c.owner).addSupportedToken(c.wAddr, await c.btcFeed.getAddress(), 18, false))
      .to.be.revertedWithCustomError(c.g, "InvalidParams");
    const feed2 = await (await ethers.getContractFactory("MockFeed")).deploy(BTC_FEED, 8);
    await expect(c.m.connect(c.owner).addSupportedToken(c.wAddr, await feed2.getAddress(), 8, false))
      .to.emit(c.m, "TokenFeedChanged");
    expect((await c.m.getSupportedTokens()).length).to.equal(n);
    expect(await c.m.totalExposureUSDC()).to.equal(before);
  });

  /** عقد اختبار الخلل (لا يُنشر) — يرث MurabahaV6 فيحتاج المكتبات نفسها */
  const harness = async (c: Ctx) => {
    const h: any = await upgrades.upgradeProxy(c.m, await linkedFactory("MurabahaV6CustodyHarness"), UPG);
    return { h, hg: await withLibErrors(h) as any };
  };
  const fullSnapshot = async (c: Ctx, h: any) => {
    const list: string[] = [...(await h.getSupportedTokens())];      // [ETH, cbBTC, USDC]
    const offerV: bigint[] = [], colV: bigint[] = [];
    for (const t of list) {
      let o = 0n, k = 0n;
      for (let i = 1n; i < (await h.nextOfferId()); i++) { const x = await h.getOffer(i); if (x.state === 0n && x.saleToken === t) o += x.saleAmount; }
      for (let i = 1n; i < (await h.nextPositionId()); i++) { const x = await h.getPosition(i); if (x.state === 0n && x.collateralToken === t) k += x.collateralAmount; }
      offerV.push(o); colV.push(k);
    }
    return { list, offerV, colV };
  };

  it("#14 خلل محاسبي: الخروج ينجح، الإيداع يتوقف، المصالحة محمية — CAP-V3-03", async () => {
    const c = await deploy();
    const { h, hg } = await harness(c);
    await btcOffer(c, c.seller, BTC(0.1));
    await h.forceOfferCustody(c.wAddr, BTC(0.05));                        // عدّاد ناقص مفروض
    const bal = await c.wbtc.balanceOf(c.seller.address);
    await expect(h.connect(c.seller).cancelOffer(1)).to.emit(h, "AccountingFaultDetected");
    expect(await c.wbtc.balanceOf(c.seller.address)).to.equal(bal + BTC(0.1)); // الخروج اكتمل
    expect(await h.accountingFault()).to.equal(true);
    await expect(btcOffer(c, c.seller, BTC(0.01))).to.be.revertedWithCustomError(hg, "AccountingFault");

    const snap = await fullSnapshot(c, h);
    await expect(h.connect(c.owner).reconcileCustody(snap.list, snap.offerV, snap.colV))
      .to.be.revertedWithCustomError(hg, "ExpectedPause");                 // بلا إيقاف
    await h.connect(c.owner).pause();
    await expect(h.connect(c.stranger).reconcileCustody(snap.list, snap.offerV, snap.colV))
      .to.be.revertedWithCustomError(hg, "OwnableUnauthorizedAccount");
    const bad = [...snap.offerV]; bad[1] = BTC(1);                         // cbBTC وحده يخالف I2
    await expect(h.connect(c.owner).reconcileCustody(snap.list, bad, snap.colV))
      .to.be.revertedWithCustomError(hg, "CustodyInsolvent");
    await h.connect(c.owner).reconcileCustody(snap.list, snap.offerV, snap.colV);
    await h.connect(c.owner).unpause();
    expect(await h.accountingFault()).to.equal(false);
    await btcOffer(c, c.seller, BTC(0.01));                                // الإيداع عاد
  });

  it("#14b خلل في رمزين: العلم لا يُمسح إلا بلقطة كاملة صحيحة", async () => {
    const c = await deploy();
    const { h, hg } = await harness(c);
    await btcOffer(c, c.seller, BTC(0.1));
    await h.connect(c.seller).createOffer(ZERO, ZERO, await c.usdc.getAddress(), 0, 1000, 1, 12, INTERVAL, 0, 12000, false, { value: E("1") });
    await h.forceOfferCustody(c.wAddr, BTC(0.05));
    await h.forceOfferCustody(ZERO, E("0.5"));
    await h.connect(c.seller).cancelOffer(1);
    await h.connect(c.seller).cancelOffer(2);
    expect(await h.accountingFault()).to.equal(true);
    await h.connect(c.owner).pause();
    const { list, offerV, colV } = await fullSnapshot(c, h);
    const bad = (t: string[], o: bigint[], k: bigint[]) =>
      expect(h.connect(c.owner).reconcileCustody(t, o, k)).to.be.revertedWithCustomError(hg, "InvalidParams");
    await bad([], [], []);                                                         // فارغة
    await bad([c.wAddr], [offerV[1]], [colV[1]]);                                  // رمز واحد — ناقصة
    await bad([list[1], list[0], list[2]], [offerV[1], offerV[0], offerV[2]], [colV[1], colV[0], colV[2]]); // ترتيب
    await bad([list[0], list[1], list[1]], offerV, colV);                          // مكرّر
    await bad(list, [offerV[0], offerV[1]], colV);                                 // اختلاف الطول
    await bad([list[0], list[1], c.stranger.address], offerV, colV);               // رمز غريب
    expect(await h.accountingFault()).to.equal(true);
    await h.connect(c.owner).reconcileCustody(list, offerV, colV);
    expect(await h.accountingFault()).to.equal(false);
  });

  it("#15 سحب يتجاوز المحاسبة: قاطع I2 يوقف الإيداع", async () => {
    const c = await deploy();
    const { h, hg } = await harness(c);
    await btcOffer(c, c.seller, BTC(0.1));
    await h.forceDrain(c.wAddr, c.stranger.address, BTC(0.03));
    await expect(btcOffer(c, c.seller2, BTC(0.01))).to.be.revertedWithCustomError(hg, "CustodyInsolvent");
  });

  it("#16 الحجم: MurabahaV6 تحت حدّ EIP-170 (24,576)", async () => {
    const a = await artifacts.readArtifact("MurabahaV6");
    const size = (a.deployedBytecode.length - 2) / 2;
    console.log(`      MurabahaV6 runtime = ${size} بايت · الهامش = ${24_576 - size}`);
    expect(size).to.be.lte(24_576);
  });
});

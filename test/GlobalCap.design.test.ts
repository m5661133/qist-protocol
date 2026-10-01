import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployScenario, runScenario, recomputeCustody, OPS,
  U, BTC, E, INTERVAL, GRACE, ETH_FEED, BTC_FEED,
} from "./helpers/custodyScenario";

/**
 * اختبارات تصميم السقف الإجمالي v2 — docs/global-cap-design.md (القسم 8)
 *
 * ⏸ موقوفة (describe.skip): تختبر واجهة لم تُنفَّذ بعد في MurabahaV6:
 *    custodyOf(token) · globalCapUSDC() · commitmentCapUSDC() · accountingFault()
 *    setCustodyCaps(global, commitment) · totalExposureUSDC() · untrackedBalance(token)
 *    reconcileCustody(address[], uint256[]) · initializeV3(global, commitment)
 *    errors: GlobalCapExceeded(uint256,uint256) · AccountingFault() · CustodyInsolvent(address,uint256,uint256)
 * و#14/#15 تحتاجان عقد اختبار contracts/test/MurabahaV6CustodyHarness.sol (forceCustody/forceDrain).
 * تُفعَّل بإزالة `.skip` بعد التنفيذ والمراجعة.
 */

const GLOBAL = U(20_000);
const COMMIT = U(17_000);  // الاحتياطي = 3,000 (قرار المالك: سقف 20,000)
const Q_BTC = 60000n * 10n ** 6n;
const Q_ETH = 3000n * 10n ** 6n;

async function deploy() {
  const s = await deployScenario();
  return { ...s, g: s.m as any };
}
type Ctx = Awaited<ReturnType<typeof deploy>>;
const caps = (c: Ctx, g = GLOBAL, k = COMMIT) => c.g.connect(c.owner).setCustodyCaps(g, k);

async function btcOffer(c: Ctx, who: any, amount: bigint, colToken?: string) {
  return c.m.connect(who).createOffer(c.wAddr, colToken ?? c.wAddr, await c.usdc.getAddress(), amount, 1000, 1, 12, INTERVAL, 0, 12000, false);
}

describe.skip("GlobalCap v2 — سقف إجمالي صارم لكل أموال العقد (تصميم)", () => {

  it("#1 عروض من عدّة بائعين: آخر عرض فوق commitmentCap يُرفض", async () => {
    const c = await deploy(); await caps(c);
    await btcOffer(c, c.seller,  BTC(0.16));  // $9,600
    await btcOffer(c, c.seller2, BTC(0.12));  // $7,200 ⇒ $16,800
    expect(await c.g.totalExposureUSDC()).to.equal(U(16_800));
    await expect(btcOffer(c, c.seller2, BTC(0.004))) // $240 ⇒ $17,040
      .to.be.revertedWithCustomError(c.m, "GlobalCapExceeded").withArgs(U(17_040), COMMIT);
  });

  it("#2 increaseOffer فوق الحدّ يُرفض", async () => {
    const c = await deploy(); await caps(c);
    await btcOffer(c, c.seller, BTC(0.28)); // $16,800
    await expect(c.m.connect(c.seller).increaseOffer(1, BTC(0.004))) // ⇒ $17,040
      .to.be.revertedWithCustomError(c.m, "GlobalCapExceeded");
  });

  it("#3 buy على الصافي: الأصل المباع يخرج والضمان يدخل", async () => {
    const c = await deploy(); await caps(c, GLOBAL, U(7_000));
    await btcOffer(c, c.seller, BTC(0.10)); // $6,000
    await expect(c.m.connect(c.buyer).buy(1, BTC(0.10), BTC(0.13), Q_BTC, 12, false)) // ضمان $7,800 > 7,000
      .to.be.revertedWithCustomError(c.m, "GlobalCapExceeded");
    await caps(c);
    await c.m.connect(c.buyer).buy(1, BTC(0.10), BTC(0.13), Q_BTC, 12, false);
    expect(await c.g.totalExposureUSDC()).to.equal(U(7_800)); // الضمان وحده
  });

  it("#4 لا عدّ مزدوج: التصفية إلى المعلّق لا تغيّر الإجمالي، والسحب يُنقصه", async () => {
    const c = await deploy();
    const usdcAddr = await c.usdc.getAddress();
    await c.m.connect(c.seller).createOffer(ethers.ZeroAddress, ethers.ZeroAddress, usdcAddr, 0, 1000, 1, 12, INTERVAL, 0, 12000, false, { value: E("1") });
    await c.m.connect(c.buyer).buy(1, E("1"), 0, Q_ETH, 12, false, { value: E("1.5") });
    const before = await c.g.totalExposureUSDC();
    await time.increase(Number(INTERVAL) + GRACE + 1);
    await c.m.connect(c.stranger).liquidatePositionPublic(1);
    expect(await c.g.custodyOf(ethers.ZeroAddress)).to.equal(0n);
    expect(await c.g.totalExposureUSDC()).to.equal(before);
    const pend = await c.m.pendingETH(c.seller.address);
    await c.m.connect(c.seller).withdrawETH();
    expect(await c.g.totalExposureUSDC()).to.equal(before - (pend * 3000n) / 10n ** 12n);
  });

  it("#5 التبرّع لا يُحسب ويظهر منفصلاً في untrackedBalance", async () => {
    const c = await deploy();
    await btcOffer(c, c.seller, BTC(0.01));
    const before = await c.g.totalExposureUSDC();
    await c.wbtc.connect(c.buyer).transfer(c.mAddr, BTC(1));
    await c.stranger.sendTransaction({ to: c.mAddr, value: E("5") });
    expect(await c.g.totalExposureUSDC()).to.equal(before);
    expect(await c.g.untrackedBalance(c.wAddr)).to.equal(BTC(1));
    expect(await c.g.untrackedBalance(ethers.ZeroAddress)).to.equal(E("5"));
  });

  it("#6 ارتفاع السعر فوق السقف: الجديد مرفوض والخروج كله يعمل", async () => {
    const c = await deploy(); await caps(c);
    await btcOffer(c, c.seller, BTC(0.05));
    await c.m.connect(c.buyer).buy(1, BTC(0.05), BTC(0.075), Q_BTC, 12, false); // ضمان $4,500
    await btcOffer(c, c.seller2, BTC(0.06));                                  // $3,600 ⇒ $8,100
    await c.btcFeed.setAnswer(BTC_FEED * 3n);                                  // ⇒ $24,300 > 20,000
    await expect(btcOffer(c, c.seller, BTC(0.001))).to.be.revertedWithCustomError(c.m, "GlobalCapExceeded");
    await c.m.connect(c.buyer).payInstallment(1);
    await c.m.connect(c.seller2).decreaseOffer(2, BTC(0.01));
    await c.m.connect(c.seller2).cancelOffer(2);
    await c.m.connect(c.buyer).withdrawExcessCollateral(1, BTC(0.01));
    await c.m.connect(c.buyer).earlyRepayCash(1);
    expect(await c.g.totalExposureUSDC()).to.equal(0n);
  });

  it("#7 مغذٍّ متقادم: الإيداع مرفوض (fail-closed)، والخروج بلا سعر يعمل", async () => {
    const c = await deploy(); await caps(c);
    await btcOffer(c, c.seller, BTC(0.05));
    await c.m.connect(c.buyer).buy(1, BTC(0.05), BTC(0.075), Q_BTC, 12, false);
    await btcOffer(c, c.seller2, BTC(0.02));
    await c.btcFeed.setStale(7200);
    await expect(c.m.connect(c.seller).createOffer(ethers.ZeroAddress, ethers.ZeroAddress, await c.usdc.getAddress(), 0, 1000, 1, 12, INTERVAL, 0, 12000, false, { value: E("0.1") }))
      .to.be.revertedWithCustomError(c.m, "StalePrice");
    await c.m.connect(c.buyer).payInstallment(1);
    await c.m.connect(c.seller2).cancelOffer(2);
    await c.m.connect(c.buyer).earlyRepayCash(1);
  });

  it("#7b تعطّل ثم عودة: السداد أثناء التعطّل يرفع HF، والتعزيز بعد العودة ضمن الاحتياطي", async () => {
    const c = await deploy(); await caps(c);
    await btcOffer(c, c.seller, BTC(0.05), ethers.ZeroAddress);
    await c.m.connect(c.buyer).buy(1, BTC(0.05), 0, Q_BTC, 12, false, { value: E("1.5") });
    const hf0 = await c.m.healthFactor(1);
    await c.ethFeed.setStale(7200);
    await expect(c.m.connect(c.buyer).addCollateral(1, 0, { value: E("0.1") }))
      .to.be.revertedWithCustomError(c.m, "StalePrice");                     // التعزيز متعذّر
    await expect(c.m.connect(c.stranger).liquidatePositionPublic(1)).to.be.reverted; // والتصفية متعذّرة
    for (let i = 0; i < 3; i++) await c.m.connect(c.buyer).payInstallment(1);   // مسار الدين متاح
    await c.ethFeed.setAnswer(ETH_FEED);                                          // عودة المغذّي
    expect(await c.m.healthFactor(1)).to.be.greaterThan(hf0);
    await c.m.connect(c.buyer).addCollateral(1, 0, { value: E("0.1") });          // التعزيز يعود
  });

  it("#8 احتياطي الإنقاذ داخل السقف الصارم", async () => {
    const c = await deploy(); await caps(c);
    // مركز: بيع cbBTC بضمان ETH — دين $3,234، ضمان 1.5 ETH
    await btcOffer(c, c.seller, BTC(0.05), ethers.ZeroAddress);
    await c.m.connect(c.buyer).buy(1, BTC(0.05), 0, Q_BTC, 12, false, { value: E("1.5") });
    await c.ethFeed.setAnswer(240_000_000_000n);          // ETH $2,400 ⇒ ضمان $3,600، HF ≈ 111%
    await btcOffer(c, c.seller2, BTC(0.22));              // $13,200 ⇒ إجمالي $16,800 ≤ 17,000

    // (أ) التزام جديد يتجاوز commitmentCap ⇒ مرفوض
    await expect(btcOffer(c, c.seller2, BTC(0.005))).to.be.revertedWithCustomError(c.m, "GlobalCapExceeded");
    // (ب) إنقاذ في نطاق الاحتياطي حتى HF ≤ 150% ⇒ مسموح (إجمالي $17,520، HF ≈ 134%)
    await c.m.connect(c.buyer).addCollateral(1, 0, { value: E("0.3") });
    // (ج) ركن فوق 150% في نطاق الاحتياطي ⇒ مرفوض (HF ≈ 156%)
    await expect(c.m.connect(c.buyer).addCollateral(1, 0, { value: E("0.3") }))
      .to.be.revertedWithCustomError(c.m, "GlobalCapExceeded");
    // (د) تجاوز globalCap مرفوض دائماً حتى للإنقاذ
    await c.btcFeed.setAnswer((BTC_FEED * 13n) / 10n);    // العرض ⇒ $17,160
    await c.ethFeed.setAnswer(195_000_000_000n);          // ضمان 1.8 ETH ⇒ $3,510، HF ≈ 108.5%
    await expect(c.m.connect(c.buyer).addCollateral(1, 0, { value: E("0.3") })) // ⇒ $21,255 > 20,000
      .to.be.revertedWithCustomError(c.m, "GlobalCapExceeded").withArgs(anyUint(), GLOBAL);
  });

  it("#9 السقف 0 = معطّل · الإعداد للمالك فقط · commitmentCap ≤ globalCap", async () => {
    const c = await deploy();
    expect(await c.g.globalCapUSDC()).to.equal(0n);
    await btcOffer(c, c.seller, BTC(5)); // $300,000 — لا حدّ
    await expect(c.g.connect(c.stranger).setCustodyCaps(GLOBAL, COMMIT))
      .to.be.revertedWithCustomError(c.m, "OwnableUnauthorizedAccount");
    await expect(c.g.connect(c.owner).setCustodyCaps(GLOBAL, GLOBAL + 1n))
      .to.be.revertedWithCustomError(c.m, "InvalidParams");
    await expect(caps(c)).to.emit(c.m, "CustodyCapsSet").withArgs(GLOBAL, COMMIT);
  });

  it("#10 الثابت I1 بعد كل خطوة من مولّد السيناريوهات المُثبَتة تغطيته", async () => {
    const c = await deploy();
    const ok = await runScenario(c, 20261001, 120, async () => {
      expect(await c.g.custodyOf(ethers.ZeroAddress)).to.equal(await recomputeCustody(c, ethers.ZeroAddress));
      expect(await c.g.custodyOf(c.wAddr)).to.equal(await recomputeCustody(c, c.wAddr));
      expect(await c.g.accountingFault()).to.equal(false);
    });
    for (const op of OPS) expect(ok[op], op).to.be.greaterThan(0);
  });

  describe("#11 الترحيل من Build 21", () => {
    // ⚠️ عند التنفيذ: contracts/legacy/MurabahaV6Build21.sol = مصدر التنفيذ الحي 0x0C01…83A7 (ببصمة bytecode)
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
    const upgradeTo = (p: any, signer: any) => ethers.getContractFactory("MurabahaV6", signer).then((F) =>
      upgrades.upgradeProxy(p, F, { unsafeAllow: ["constructor"], call: { fn: "initializeV3", args: [GLOBAL, COMMIT] } }));

    it("حالة مركّبة: مراكز مفتوحة ETH وcbBTC + ETH معلّق للبائع والخزينة + عرض ملغى", async () => {
      const L = await legacy();
      await L.p.connect(L.seller).createOffer(ethers.ZeroAddress, ethers.ZeroAddress, L.u, 0, 1000, 1, 12, INTERVAL, 0, 12000, false, { value: E("2") }); // #1
      await L.p.connect(L.seller).createOffer(L.w, L.w, L.u, BTC(0.1), 1000, 1, 12, INTERVAL, 0, 12000, false);                                     // #2
      await L.p.connect(L.seller).createOffer(L.w, L.w, L.u, BTC(0.02), 1000, 1, 12, INTERVAL, 0, 12000, false);                                    // #3
      await L.p.connect(L.seller).cancelOffer(3);
      await L.p.connect(L.buyer).buy(1, E("0.5"), 0, Q_ETH, 12, false, { value: E("0.8") }); // رسوم ETH ⇒ معلّق للخزينة
      await L.p.connect(L.buyer).buy(1, E("0.5"), 0, Q_ETH, 12, false, { value: E("0.8") });
      await L.p.connect(L.buyer).buy(2, BTC(0.05), BTC(0.07), Q_BTC, 12, false);
      await time.increase(GRACE + 3600);
      await L.p.connect(L.stranger).liquidatePositionPublic(1); // ⇒ معلّق للبائع والمشتري
      const pendBefore = await L.p.totalPendingETH();
      expect(pendBefore).to.be.greaterThan(0n);

      const New = await ethers.getContractFactory("MurabahaV6");
      await upgrades.validateUpgrade(L.p, New, { kind: "uups", unsafeAllow: ["constructor"] });
      const up: any = await upgradeTo(L.p, L.owner);
      // العهدة = العرض #1 المتبقي + ضمان المركز #2 (ETH) | العرض #2 المتبقي + ضمان المركز #3 (cbBTC)
      expect(await up.custodyOf(ethers.ZeroAddress)).to.equal(E("1") + E("0.8"));
      expect(await up.custodyOf(L.w)).to.equal(BTC(0.05) + BTC(0.07));
      expect(await up.totalPendingETH()).to.equal(pendBefore); // C محسوب في الإجمالي لا في custodyOf
      expect(await up.accountingFault()).to.equal(false);
      await expect(up.connect(L.owner).initializeV3(GLOBAL, COMMIT)).to.be.reverted; // مرة واحدة فقط
    });

    it("initializeV3 لغير المالك ⇒ مرفوضة", async () => {
      const L = await legacy();
      await expect(upgradeTo(L.p, L.stranger)).to.be.reverted;
    });

    it("tokenList مكرّرة في الحالة القديمة ⇒ الترقية تُرفض", async () => {
      const L = await legacy();
      await L.p.connect(L.owner).removeSupportedToken(L.w);
      await L.p.connect(L.owner).addSupportedToken(L.w, await (await ethers.getContractFactory("MockFeed")).deploy(BTC_FEED, 8).then((f) => f.getAddress()), 8, false);
      expect((await L.p.getSupportedTokens()).length).to.equal(4); // يثبت خلل Build 21
      await expect(upgradeTo(L.p, L.owner)).to.be.reverted;
    });
  });

  it("#12 رمز مُطفأ بعهدة قائمة يبقى محسوباً", async () => {
    const c = await deploy();
    await btcOffer(c, c.seller, BTC(0.1));
    const before = await c.g.totalExposureUSDC();
    await c.m.connect(c.owner).removeSupportedToken(c.wAddr);
    expect(await c.g.totalExposureUSDC()).to.equal(before);
  });

  it("#13 إعادة تفعيل رمز: لا تكرار ولا تضاعف · العشريات ثابتة · تغيير المغذّي معلَن", async () => {
    const c = await deploy();
    await btcOffer(c, c.seller, BTC(0.1));
    const before = await c.g.totalExposureUSDC();
    const n = (await c.m.getSupportedTokens()).length;
    await c.m.connect(c.owner).removeSupportedToken(c.wAddr);
    await expect(c.m.connect(c.owner).addSupportedToken(c.wAddr, await c.btcFeed.getAddress(), 18, false))
      .to.be.revertedWithCustomError(c.m, "InvalidParams");                   // عشريات مختلفة
    const feed2 = await (await ethers.getContractFactory("MockFeed")).deploy(BTC_FEED, 8);
    await expect(c.m.connect(c.owner).addSupportedToken(c.wAddr, await feed2.getAddress(), 8, false))
      .to.emit(c.m, "TokenFeedChanged");
    expect((await c.m.getSupportedTokens()).length).to.equal(n);
    expect(await c.g.totalExposureUSDC()).to.equal(before);
  });

  it("#14 خلل محاسبي: الخروج ينجح، الإيداع يتوقف، المصالحة محمية", async () => {
    const H = await ethers.getContractFactory("MurabahaV6CustodyHarness");
    const c = await deploy();
    const h: any = await upgrades.upgradeProxy(c.m, H, { unsafeAllow: ["constructor"] });
    await btcOffer(c, c.seller, BTC(0.1));
    await h.forceCustody(c.wAddr, BTC(0.05));                        // عدّاد ناقص مفروض
    const bal = await c.wbtc.balanceOf(c.seller.address);
    await expect(h.connect(c.seller).cancelOffer(1)).to.emit(h, "AccountingFaultDetected");
    expect(await c.wbtc.balanceOf(c.seller.address)).to.equal(bal + BTC(0.1)); // الخروج اكتمل
    expect(await h.accountingFault()).to.equal(true);
    await expect(btcOffer(c, c.seller, BTC(0.01))).to.be.revertedWithCustomError(h, "AccountingFault");

    await expect(h.connect(c.owner).reconcileCustody([c.wAddr], [0n]))
      .to.be.revertedWithCustomError(h, "ExpectedPause");             // بلا إيقاف ⇒ مرفوضة
    await h.connect(c.owner).pause();
    await expect(h.connect(c.stranger).reconcileCustody([c.wAddr], [0n]))
      .to.be.revertedWithCustomError(h, "OwnableUnauthorizedAccount");
    await expect(h.connect(c.owner).reconcileCustody([c.wAddr], [BTC(1)]))
      .to.be.revertedWithCustomError(h, "CustodyInsolvent");          // تخالف I2
    await h.connect(c.owner).reconcileCustody([c.wAddr], [await recomputeCustody(c, c.wAddr)]);
    await h.connect(c.owner).unpause();
    expect(await h.accountingFault()).to.equal(false);
    await btcOffer(c, c.seller, BTC(0.01));                           // الإيداع عاد
  });

  it("#15 سحب يتجاوز المحاسبة: قاطع I2 يوقف الإيداع", async () => {
    const H = await ethers.getContractFactory("MurabahaV6CustodyHarness");
    const c = await deploy();
    const h: any = await upgrades.upgradeProxy(c.m, H, { unsafeAllow: ["constructor"] });
    await btcOffer(c, c.seller, BTC(0.1));
    await h.forceDrain(c.wAddr, c.stranger.address, BTC(0.03));      // يحاكي ثغرة
    await expect(btcOffer(c, c.seller2, BTC(0.01))).to.be.revertedWithCustomError(h, "CustodyInsolvent");
  });
});

// مطابِق لأي قيمة uint (chai withArgs)
function anyUint() { return (v: bigint) => typeof v === "bigint"; }

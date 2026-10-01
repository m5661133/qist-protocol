import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * اختبارات تصميم السقف الإجمالي — docs/global-cap-design.md
 *
 * ⏸ موقوفة (describe.skip): تختبر واجهة لم تُنفَّذ بعد في MurabahaV6:
 *    custodyOf(token) · globalCapUSDC() · setGlobalCap(uint256) · totalExposureUSDC()
 *    remainingCapacityUSDC() · error GlobalCapExceeded(uint256,uint256) · initializeV3(uint256)
 * تُفعَّل بإزالة `.skip` بعد التنفيذ والمراجعة. كل حالة مربوطة برقمها في القسم 6 من التصميم.
 */

const U   = (n: number) => BigInt(Math.round(n * 1e6));
const BTC = (n: number) => BigInt(Math.round(n * 1e8));
const E   = ethers.parseEther;
const INTERVAL = 60n;
const GRACE = 259200;
const ETH_FEED = 300_000_000_000n;   // $3,000
const BTC_FEED = 6_000_000_000_000n; // $60,000
const Q_BTC = 60000n * 10n ** 6n;
const Q_ETH = 3000n * 10n ** 6n;
const CAP = U(10_000);

async function deploy() {
  const [owner, seller, seller2, buyer, buyer2, stranger] = await ethers.getSigners();
  const usdc    = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const wbtc    = await (await ethers.getContractFactory("MockWBTC")).deploy();
  const ethFeed = await (await ethers.getContractFactory("MockFeed")).deploy(ETH_FEED, 8);
  const btcFeed = await (await ethers.getContractFactory("MockFeed")).deploy(BTC_FEED, 8);
  const m = await upgrades.deployProxy(await ethers.getContractFactory("MurabahaV6"), [
    await usdc.getAddress(), await wbtc.getAddress(),
    await ethFeed.getAddress(), await btcFeed.getAddress(), owner.address, owner.address,
  ], { kind: "uups", unsafeAllow: ["constructor"] });
  for (const s of [seller, seller2]) await wbtc.mint(s.address, BTC(10));
  for (const b of [buyer, buyer2]) { await wbtc.mint(b.address, BTC(10)); await usdc.mint(b.address, U(1_000_000)); }
  const mAddr = await m.getAddress();
  for (const a of [seller, seller2, buyer, buyer2]) {
    await wbtc.connect(a).approve(mAddr, ethers.MaxUint256);
    await usdc.connect(a).approve(mAddr, ethers.MaxUint256);
  }
  const g = m as any; // الواجهة الجديدة غير موجودة في typechain بعد
  return { m, g, usdc, wbtc, ethFeed, btcFeed, owner, seller, seller2, buyer, buyer2, stranger, mAddr };
}
type Ctx = Awaited<ReturnType<typeof deploy>>;

/** عرض cbBTC بضمان مختار */
async function btcOffer(ctx: Ctx, who: any, amount: bigint, colToken?: string) {
  const w = await ctx.wbtc.getAddress();
  return ctx.m.connect(who).createOffer(w, colToken ?? w, await ctx.usdc.getAddress(), amount, 1000, 1, 12, INTERVAL, 0, 12000, false);
}

describe.skip("GlobalCap — سقف إجمالي لكل أموال العقد (تصميم)", () => {

  it("#1 عروض من عدّة بائعين: آخر عرض يتجاوز الإجمالي يُرفض", async () => {
    const ctx = await deploy();
    await ctx.g.connect(ctx.owner).setGlobalCap(CAP);
    await btcOffer(ctx, ctx.seller,  BTC(0.10)); // $6,000
    await btcOffer(ctx, ctx.seller2, BTC(0.06)); // $3,600 ⇒ $9,600
    expect(await ctx.g.totalExposureUSDC()).to.equal(U(9_600));
    await expect(btcOffer(ctx, ctx.seller2, BTC(0.01))) // $600 ⇒ $10,200
      .to.be.revertedWithCustomError(ctx.m, "GlobalCapExceeded");
  });

  it("#2 increaseOffer يتجاوز السقف ⇒ يُرفض", async () => {
    const ctx = await deploy();
    await ctx.g.connect(ctx.owner).setGlobalCap(CAP);
    await btcOffer(ctx, ctx.seller, BTC(0.16)); // $9,600
    await expect(ctx.m.connect(ctx.seller).increaseOffer(1, BTC(0.01)))
      .to.be.revertedWithCustomError(ctx.m, "GlobalCapExceeded");
  });

  it("#3 buy يُحسب على الصافي: الأصل المباع يخرج والضمان يدخل", async () => {
    const ctx = await deploy();
    await ctx.g.connect(ctx.owner).setGlobalCap(U(8_000));
    await btcOffer(ctx, ctx.seller, BTC(0.10)); // $6,000
    // ضمان $9,000 والأصل المباع يخرج ⇒ الإجمالي $9,000 > $8,000
    await expect(ctx.m.connect(ctx.buyer).buy(1, BTC(0.10), BTC(0.15), Q_BTC, 12, false))
      .to.be.revertedWithCustomError(ctx.m, "GlobalCapExceeded");
    await ctx.g.connect(ctx.owner).setGlobalCap(CAP);
    await ctx.m.connect(ctx.buyer).buy(1, BTC(0.10), BTC(0.15), Q_BTC, 12, false);
    expect(await ctx.g.totalExposureUSDC()).to.equal(U(9_000)); // الضمان وحده — لا العرض المُباع
  });

  it("#4 لا عدّ مزدوج: التصفية إلى ETH المعلّق لا تغيّر الإجمالي، والسحب يُنقصه", async () => {
    const ctx = await deploy();
    const usdcAddr = await ctx.usdc.getAddress();
    await ctx.m.connect(ctx.seller).createOffer(ethers.ZeroAddress, ethers.ZeroAddress, usdcAddr, 0, 1000, 1, 12, INTERVAL, 0, 12000, false, { value: E("1") });
    await ctx.m.connect(ctx.buyer).buy(1, E("1"), 0, Q_ETH, 12, false, { value: E("1.5") });
    const before = await ctx.g.totalExposureUSDC();          // ضمان 1.5 ETH + رسوم ETH المعلّقة للخزائن
    await time.increase(Number(INTERVAL) + GRACE + 1);
    await ctx.m.connect(ctx.stranger).liquidatePositionPublic(1); // البائع والمشتري ليسا msg.sender ⇒ pending
    expect(await ctx.g.custodyOf(ethers.ZeroAddress)).to.equal(0n);
    expect(await ctx.g.totalExposureUSDC()).to.equal(before);     // انتقل من الضمان إلى المعلّق — لم يُضاعَف
    const pend = await ctx.m.pendingETH(ctx.seller.address);
    await ctx.m.connect(ctx.seller).withdrawETH();
    expect(await ctx.g.totalExposureUSDC()).to.equal(before - (pend * 3000n) / 10n ** 12n);
  });

  it("#5 التبرّع المباشر لا يُحسب (مقاومة إغراق السقف)", async () => {
    const ctx = await deploy();
    await btcOffer(ctx, ctx.seller, BTC(0.01));
    const before = await ctx.g.totalExposureUSDC();
    await ctx.wbtc.connect(ctx.buyer).transfer(ctx.mAddr, BTC(1));
    await ctx.stranger.sendTransaction({ to: ctx.mAddr, value: E("5") });
    expect(await ctx.g.totalExposureUSDC()).to.equal(before);
  });

  it("#6 ارتفاع السعر فوق السقف: الجديد يُرفض والخروج كله يعمل", async () => {
    const ctx = await deploy();
    await ctx.g.connect(ctx.owner).setGlobalCap(CAP);
    await btcOffer(ctx, ctx.seller, BTC(0.05));                                   // عرض #1
    await ctx.m.connect(ctx.buyer).buy(1, BTC(0.05), BTC(0.075), Q_BTC, 12, false); // مركز #1: ضمان $4,500
    await btcOffer(ctx, ctx.seller2, BTC(0.08));                                  // عرض #2: $4,800 ⇒ $9,300
    await ctx.btcFeed.setAnswer(BTC_FEED * 2n);                                    // ⇒ $18,600
    expect(await ctx.g.totalExposureUSDC()).to.be.greaterThan(CAP);

    await expect(btcOffer(ctx, ctx.seller, BTC(0.001)))
      .to.be.revertedWithCustomError(ctx.m, "GlobalCapExceeded");
    await ctx.m.connect(ctx.buyer).payInstallment(1);
    await ctx.m.connect(ctx.seller2).decreaseOffer(2, BTC(0.01));
    await ctx.m.connect(ctx.seller2).cancelOffer(2);
    await ctx.m.connect(ctx.buyer).withdrawExcessCollateral(1, BTC(0.01));
    await ctx.m.connect(ctx.buyer).earlyRepayCash(1);
    expect(await ctx.g.totalExposureUSDC()).to.equal(0n);
  });

  it("#7 مغذٍّ متقادم: الإيداع الجديد يُرفض، والخروج الذي لا يحتاج سعراً يعمل", async () => {
    const ctx = await deploy();
    await ctx.g.connect(ctx.owner).setGlobalCap(CAP);
    await btcOffer(ctx, ctx.seller, BTC(0.05));
    await ctx.m.connect(ctx.buyer).buy(1, BTC(0.05), BTC(0.075), Q_BTC, 12, false);
    await btcOffer(ctx, ctx.seller2, BTC(0.02));
    await ctx.btcFeed.setStale(7200);

    await expect(ctx.m.connect(ctx.seller).createOffer(ethers.ZeroAddress, ethers.ZeroAddress, await ctx.usdc.getAddress(), 0, 1000, 1, 12, INTERVAL, 0, 12000, false, { value: E("0.1") }))
      .to.be.revertedWithCustomError(ctx.m, "StalePrice"); // fail-closed — الإجمالي لا يُحسب
    await ctx.m.connect(ctx.buyer).payInstallment(1);
    await ctx.m.connect(ctx.seller2).cancelOffer(2);
    await ctx.m.connect(ctx.buyer).earlyRepayCash(1);
  });

  it("#8 addCollateral فوق السقف: إنقاذ حتى HF ≤ 150% مسموح، وما فوقه يُرفض", async () => {
    const ctx = await deploy();
    await ctx.g.connect(ctx.owner).setGlobalCap(CAP);
    // مركز: بيع cbBTC بضمان ETH (دين ≈ $3,234، ضمان 1.5 ETH = $4,500)
    await btcOffer(ctx, ctx.seller, BTC(0.05), ethers.ZeroAddress);
    await ctx.m.connect(ctx.buyer).buy(1, BTC(0.05), 0, Q_BTC, 12, false, { value: E("1.5") });
    await btcOffer(ctx, ctx.seller2, BTC(0.08));      // عرض قائم $4,800
    await ctx.btcFeed.setAnswer(BTC_FEED * 2n);       // الإجمالي فوق السقف
    await ctx.ethFeed.setAnswer(240_000_000_000n);    // ETH $2,400 ⇒ HF ≈ 111%
    expect(await ctx.g.totalExposureUSDC()).to.be.greaterThan(CAP);

    await ctx.m.connect(ctx.buyer).addCollateral(1, 0, { value: E("0.3") }); // HF ≈ 134% — إنقاذ
    await expect(ctx.m.connect(ctx.buyer).addCollateral(1, 0, { value: E("2") })) // HF ≈ 282%
      .to.be.revertedWithCustomError(ctx.m, "GlobalCapExceeded");
  });

  it("#9 السقف 0 = معطّل · setGlobalCap للمالك فقط", async () => {
    const ctx = await deploy();
    expect(await ctx.g.globalCapUSDC()).to.equal(0n);
    await btcOffer(ctx, ctx.seller, BTC(5)); // $300,000 — لا حدّ
    await expect(ctx.g.connect(ctx.stranger).setGlobalCap(CAP))
      .to.be.revertedWithCustomError(ctx.m, "OwnableUnauthorizedAccount");
    await expect(ctx.g.connect(ctx.owner).setGlobalCap(CAP)).to.emit(ctx.m, "GlobalCapSet");
    expect(await ctx.g.remainingCapacityUSDC()).to.equal(0n); // خفض السقف تحت القائم مسموح
  });

  it("#10 الثابت I1: custodyOf = مجموع العروض النشطة + الضمانات النشطة بعد سلسلة عمليات", async () => {
    const ctx = await deploy();
    const w = await ctx.wbtc.getAddress();
    const recompute = async (token: string) => {
      let sum = 0n;
      for (let i = 1n; i < (await ctx.m.nextOfferId()); i++) {
        const o = await ctx.m.offers(i);
        if (o.state === 0n && o.saleToken === token) sum += o.saleAmount;
      }
      for (let i = 1n; i < (await ctx.m.nextPositionId()); i++) {
        const p = await ctx.m.positions(i);
        if (p.state === 0n && p.collateralToken === token) sum += p.collateralAmount;
      }
      return sum;
    };
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    for (let step = 0; step < 40; step++) {
      const op = rnd(6);
      try {
        if (op === 0) await btcOffer(ctx, ctx.seller, BTC(0.01 + rnd(5) / 100));
        if (op === 1) await ctx.m.connect(ctx.buyer).buy(1 + rnd(3), BTC(0.01), BTC(0.02), Q_BTC, 12, false);
        if (op === 2) await ctx.m.connect(ctx.seller).decreaseOffer(1 + rnd(3), BTC(0.005));
        if (op === 3) await ctx.m.connect(ctx.buyer).payInstallment(1 + rnd(3));
        if (op === 4) await ctx.m.connect(ctx.buyer).addCollateral(1 + rnd(3), BTC(0.001));
        if (op === 5) await ctx.m.connect(ctx.buyer).earlyRepayCash(1 + rnd(3));
      } catch { /* عملية غير صالحة في هذه الحالة — مقبول */ }
      expect(await ctx.g.custodyOf(w)).to.equal(await recompute(w));
    }
  });

  it("#11 الترحيل: initializeV3 يحسب العهدة من العروض القائمة · validateUpgrade من Build 21", async () => {
    // ⚠️ عند التنفيذ: احفظ مصدر Build 21 الحيّ كـ contracts/legacy/MurabahaV6Build21.sol
    const [owner, seller] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const wbtc = await (await ethers.getContractFactory("MockWBTC")).deploy();
    const ef = await (await ethers.getContractFactory("MockFeed")).deploy(ETH_FEED, 8);
    const bf = await (await ethers.getContractFactory("MockFeed")).deploy(BTC_FEED, 8);
    const Old = await ethers.getContractFactory("MurabahaV6Build21");
    const proxy: any = await upgrades.deployProxy(Old, [await usdc.getAddress(), await wbtc.getAddress(), await ef.getAddress(), await bf.getAddress(), owner.address, owner.address], { kind: "uups", unsafeAllow: ["constructor"] });
    // يحاكي الحالة الحية: عرض ETH 0.005 + عرض cbBTC 549,707 ساتوشي + عرض مغلق
    await wbtc.mint(seller.address, 1_000_000n);
    await wbtc.connect(seller).approve(await proxy.getAddress(), ethers.MaxUint256);
    await proxy.connect(seller).createOffer(ethers.ZeroAddress, ethers.ZeroAddress, await usdc.getAddress(), 0, 1000, 1, 12, INTERVAL, 0, 12000, false, { value: 5_000_000_000_000_000n });
    await proxy.connect(seller).createOffer(await wbtc.getAddress(), await wbtc.getAddress(), await usdc.getAddress(), 100_000n, 1000, 1, 12, INTERVAL, 0, 12000, false);
    await proxy.connect(seller).cancelOffer(2);
    await proxy.connect(seller).createOffer(await wbtc.getAddress(), await wbtc.getAddress(), await usdc.getAddress(), 549_707n, 1000, 1, 12, INTERVAL, 0, 12000, false);

    const New = await ethers.getContractFactory("MurabahaV6");
    await upgrades.validateUpgrade(proxy, New, { kind: "uups", unsafeAllow: ["constructor"] });
    const up = (await upgrades.upgradeProxy(proxy, New, {
      unsafeAllow: ["constructor"], call: { fn: "initializeV3", args: [CAP] },
    })) as any;
    expect(await up.custodyOf(ethers.ZeroAddress)).to.equal(5_000_000_000_000_000n);
    expect(await up.custodyOf(await wbtc.getAddress())).to.equal(549_707n);
    expect(await up.globalCapUSDC()).to.equal(CAP);
    // I2: العهدة ≤ الرصيد الفعلي
    expect(await wbtc.balanceOf(await up.getAddress())).to.be.greaterThanOrEqual(549_707n);
    await expect(up.initializeV3(CAP)).to.be.reverted; // لا يُستدعى مرتين
  });

  it("#12 رمز مُطفأ بعهدة قائمة يبقى محسوباً في الإجمالي", async () => {
    const ctx = await deploy();
    await btcOffer(ctx, ctx.seller, BTC(0.1));
    const before = await ctx.g.totalExposureUSDC();
    await ctx.m.connect(ctx.owner).removeSupportedToken(await ctx.wbtc.getAddress());
    expect(await ctx.g.totalExposureUSDC()).to.equal(before);
  });
});

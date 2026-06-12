// اختبارات إصلاحات التدقيق الأمني (H1 + H2) — تُكتب بأسلوب TDD
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// ── وحدات ──
const U   = (n: number) => BigInt(Math.round(n * 1e6));   // USDC 6 dec
const BTC = (n: number) => BigInt(Math.round(n * 1e8));   // WBTC 8 dec
const INTERVAL   = 60n;
const INTERVAL_N = 60;
const DAY        = 24 * 60 * 60;
const ETH_FEED   = 300_000_000_000n;   // $3,000 (8 dec)
const BTC_FEED   = 6_000_000_000_000n; // $60,000 (8 dec)
const Q_BTC      = 60000n * 10n ** 6n;

// ── نشر proxy + Mocks (مطابق للـ fixture الرئيسي) ──
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
    owner.address, owner.address,
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

async function openPosition(ctx: Ctx) {
  const { m, wbtc, usdc, seller, buyer } = ctx;
  const mAddr = await m.getAddress();
  const wbtcAddr = await wbtc.getAddress();
  const usdcAddr = await usdc.getAddress();
  await wbtc.connect(seller).approve(mAddr, BTC(100));
  await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
  await wbtc.connect(buyer).approve(mAddr, BTC(50));
  await usdc.connect(buyer).approve(mAddr, U(2_000_000));
  await m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q_BTC, 12, false);
}

// ═══════════════════════════════════════════════════════════════════════════
// H1 — GRACE_PERIOD يجب أن يكون مهلة الإنتاج (3 أيام)، لا قيمة الاختبار 180s
// ═══════════════════════════════════════════════════════════════════════════
describe("H1 — GRACE_PERIOD: مهلة الإنتاج 3 أيام", () => {
  it("مركز سليم الضمان متأخّر يومين ليس قابلاً للتصفية (يومان < 3 أيام)", async () => {
    const ctx = await deploy();
    await openPosition(ctx);
    // تأخّر يومين فقط بعد موعد القسط — أقل من مهلة الإنتاج (3 أيام)
    await time.increase(INTERVAL_N + 2 * DAY);
    const [ok] = await ctx.m.isLiquidatable(1);
    expect(ok).to.equal(false); // يجب ألا يُصفّى قبل مرور 3 أيام
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H2 — فحص Chainlink L2 Sequencer Uptime قبل الاعتماد على السعر (Base = L2)
// ═══════════════════════════════════════════════════════════════════════════
async function deploySeq(answer: number, startedAt: number) {
  return (await ethers.getContractFactory("MockSequencerFeed")).deploy(answer, startedAt);
}

describe("H2 — فحص L2 Sequencer Uptime", () => {
  it("بدون ضبط feed: قراءة السعر تعمل (السلوك الحالي محفوظ على الشبكات بلا sequencer)", async () => {
    const ctx = await deploy();
    expect(await ctx.m.quotePrice(await ctx.wbtc.getAddress())).to.be.gt(0n);
  });

  it("sequencer متوقّف (answer=1) → قراءة السعر تُرفض", async () => {
    const ctx = await deploy();
    const seq = await deploySeq(1, await time.latest());
    await ctx.m.setSequencerUptimeFeed(await seq.getAddress());
    await expect(ctx.m.quotePrice(await ctx.wbtc.getAddress())).to.be.reverted;
  });

  it("sequencer عاد للتوّ (ضمن مهلة التعافي 1 ساعة) → قراءة السعر تُرفض", async () => {
    const ctx = await deploy();
    const seq = await deploySeq(0, await time.latest()); // يعمل، لكن بدأ الآن
    await ctx.m.setSequencerUptimeFeed(await seq.getAddress());
    await expect(ctx.m.quotePrice(await ctx.wbtc.getAddress())).to.be.reverted;
  });

  it("sequencer يعمل منذ ساعتين (تجاوز مهلة التعافي) → قراءة السعر تعمل", async () => {
    const ctx = await deploy();
    const seq = await deploySeq(0, (await time.latest()) - 7200);
    await ctx.m.setSequencerUptimeFeed(await seq.getAddress());
    expect(await ctx.m.quotePrice(await ctx.wbtc.getAddress())).to.be.gt(0n);
  });

  it("setSequencerUptimeFeed: غير المالك يُرفض", async () => {
    const ctx = await deploy();
    const seq = await deploySeq(0, await time.latest());
    await expect(
      ctx.m.connect(ctx.stranger).setSequencerUptimeFeed(await seq.getAddress())
    ).to.be.reverted;
  });
});

// ── حالات حدّية ومسار تكامل (من مراجعة المرحلة ٩) ──
describe("H2 — حالات حدّية ومسار التكامل", () => {
  it("sequencer بـ startedAt=0 (جولة غير صالحة) → السعر يُرفض", async () => {
    const ctx = await deploy();
    const seq = await deploySeq(0, 0); // up=0 لكن startedAt=0 → جولة غير صالحة
    await ctx.m.setSequencerUptimeFeed(await seq.getAddress());
    await expect(ctx.m.quotePrice(await ctx.wbtc.getAddress())).to.be.reverted;
  });

  it("الفحص نشط أثناء buy فعلياً (لا فقط quotePrice)", async () => {
    const ctx = await deploy();
    const { m, wbtc, usdc, seller, buyer } = ctx;
    const mAddr = await m.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdcAddr = await usdc.getAddress();
    await wbtc.connect(seller).approve(mAddr, BTC(100));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    const seq = await deploySeq(1, await time.latest()); // sequencer متوقّف
    await m.setSequencerUptimeFeed(await seq.getAddress());
    await wbtc.connect(buyer).approve(mAddr, BTC(50));
    await usdc.connect(buyer).approve(mAddr, U(2_000_000));
    await expect(m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q_BTC, 12, false)).to.be.reverted;
  });
});

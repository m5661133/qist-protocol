import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployScenario, U, BTC, INTERVAL, GRACE, BTC_FEED } from "./helpers/custodyScenario";
import { linkedFactory, withLibErrors } from "./helpers/linked";
import { planReconciliation, healthOf, totalPendingToken } from "../scripts/custody-reconcile";

/**
 * Build 23 — اختبارات انحدار لثغرات تقرير «ايجنت اسلامي/05_تقرير_ثغرة_قسط.md»:
 *  F-1 بائع محظور في USDC كان يُفشل سداد المشتري ⇒ يُصفّى رغم محاولته الدفع
 *  F-2 مشترٍ محظور في رمز الضمان كان يُعلّق المركز (لا إكمال ولا تصفية)
 *  F-3 إيقاف أطول من المهلة كان يفرض تصفية جماعية لحظة الاستئناف
 * R-1: أرسل، وإن فشل فسجّل (pendingToken + withdrawToken) · R-2: المهلة تبدأ بعد آخر استئناف.
 * على Build 22 تفشل هذه الاختبارات (revert بالحظر / تصفية فورية بعد الاستئناف).
 */
const Q_BTC = 60000n * 10n ** 6n;
const BLACKLISTED = "Blacklistable: account is blacklisted";
const COMPLETED = 1; // PositionState { ACTIVE, COMPLETED, LIQUIDATED }

async function deploy(harness = false) {
  const s = await deployScenario(harness ? () => linkedFactory("MurabahaV6CustodyHarness") : undefined);
  const uAddr = await s.usdc.getAddress();
  // عرض BTC بضمان BTC وسداد USDC — قسطان
  await s.m.connect(s.seller).createOffer(s.wAddr, s.wAddr, uAddr, BTC(0.08), 1000, 1, 12, INTERVAL, 0, 12000, false);
  await s.m.connect(s.buyer).buy(1, BTC(0.08), BTC(0.13), Q_BTC, 2, false);
  return { ...s, g: (await withLibErrors(s.m)) as any, uAddr, pid: 1n };
}

describe("Build 23 — R-1 (أرسل، وإن فشل فسجّل) + R-2 (مهلة بعد الاستئناف)", () => {

  describe("F-1: بائع محظور في USDC", () => {
    it("السداد ينجح، والقسط يُسجَّل معلّقاً للبائع (PayoutDeferred)", async () => {
      const c = await deploy();
      await c.usdc.blacklist(c.seller.address);
      const amt = await c.m.getInstallmentAmount(c.pid);
      await expect(c.m.connect(c.buyer).payInstallment(c.pid))
        .to.emit(c.m, "PayoutDeferred").withArgs(c.uAddr, c.seller.address, amt);
      expect(await c.m.pendingToken(c.uAddr, c.seller.address)).to.equal(amt);
      expect((await c.m.getPosition(c.pid)).paidInstallments).to.equal(1);
    });

    it("السداد المبكر نقداً ينجح ويكتمل المركز ويعود الضمان للمشتري", async () => {
      const c = await deploy();
      await c.usdc.blacklist(c.seller.address);
      const debt = await c.m.getRemainingDebt(c.pid);
      const before = await c.wbtc.balanceOf(c.buyer.address);
      await c.m.connect(c.buyer).earlyRepayCash(c.pid);
      expect(await c.m.pendingToken(c.uAddr, c.seller.address)).to.equal(debt);
      expect((await c.m.getPosition(c.pid)).state).to.equal(COMPLETED);
      expect(await c.wbtc.balanceOf(c.buyer.address) - before).to.equal(BTC(0.13));
    });

    it("المشتري الملتزم لا يصبح قابلاً للتصفية بسبب حظر البائع", async () => {
      const c = await deploy();
      await c.usdc.blacklist(c.seller.address);
      await time.increase(Number(INTERVAL));
      await c.m.connect(c.buyer).payInstallment(c.pid);
      await time.increase(GRACE);
      const [liq] = await c.m.isLiquidatable(c.pid);
      expect(liq).to.equal(false);
    });

    it("السحب: محظور ⇒ يفشل بالحظر · بعد رفعه ⇒ يستلم ويُصفَّر · مرة ثانية ⇒ ZeroAmount", async () => {
      const c = await deploy();
      await c.usdc.blacklist(c.seller.address);
      const amt = await c.m.getInstallmentAmount(c.pid);
      await c.m.connect(c.buyer).payInstallment(c.pid);
      await expect(c.m.connect(c.seller).withdrawToken(c.uAddr)).to.be.revertedWith(BLACKLISTED);
      await c.usdc.unBlacklist(c.seller.address);
      const before = await c.usdc.balanceOf(c.seller.address);
      await expect(c.m.connect(c.seller).withdrawToken(c.uAddr))
        .to.emit(c.g, "PayoutWithdrawn").withArgs(c.uAddr, c.seller.address, amt);
      expect(await c.usdc.balanceOf(c.seller.address) - before).to.equal(amt);
      expect(await c.m.pendingToken(c.uAddr, c.seller.address)).to.equal(0);
      await expect(c.m.connect(c.seller).withdrawToken(c.uAddr)).to.be.revertedWithCustomError(c.g, "ZeroAmount");
    });

    it("السحب لصاحب المستحق فقط: طرف آخر ⇒ ZeroAmount · ويعمل أثناء الإيقاف", async () => {
      const c = await deploy();
      await c.usdc.blacklist(c.seller.address);
      await c.m.connect(c.buyer).payInstallment(c.pid);
      await c.usdc.unBlacklist(c.seller.address);
      await expect(c.m.connect(c.stranger).withdrawToken(c.uAddr)).to.be.revertedWithCustomError(c.g, "ZeroAmount");
      await c.m.connect(c.owner).pause();
      await expect(c.m.connect(c.seller).withdrawToken(c.uAddr)).to.not.be.reverted;
    });
  });

  describe("F-2: مشترٍ محظور في رمز الضمان", () => {
    it("القسط الأخير يُكمل المركز، والضمان يُسجَّل معلّقاً للمشتري", async () => {
      const c = await deploy();
      await c.wbtc.blacklist(c.buyer.address);
      await c.m.connect(c.buyer).payInstallment(c.pid);
      await c.m.connect(c.buyer).payInstallment(c.pid);
      expect((await c.m.getPosition(c.pid)).state).to.equal(COMPLETED);
      expect(await c.m.pendingToken(c.wAddr, c.buyer.address)).to.equal(BTC(0.13));
    });

    it("تصفية التأخّر تنجح: البائع يحصّل، وفائض المشتري يُسجَّل معلّقاً", async () => {
      const c = await deploy();
      await c.wbtc.blacklist(c.buyer.address);
      await time.increase(Number(INTERVAL) + GRACE + 1);
      const sellerBefore = await c.wbtc.balanceOf(c.seller.address);
      await expect(c.m.connect(c.stranger).liquidatePositionPublic(c.pid)).to.emit(c.m, "PositionLiquidated");
      expect(await c.wbtc.balanceOf(c.seller.address)).to.be.gt(sellerBefore);
      expect(await c.m.pendingToken(c.wAddr, c.buyer.address)).to.be.gt(0);
      expect(await c.m.collateralCustody(c.wAddr)).to.equal(0);
    });
  });

  describe("F-3: الإيقاف لا يُحتسب تأخّراً (R-2)", () => {
    it("إيقاف أطول من المهلة ⇒ لا تصفية لحظة الاستئناف · 3 أيام كاملة بعده", async () => {
      const c = await deploy();
      await c.m.connect(c.owner).pause();
      await time.increase(Number(INTERVAL) + GRACE + 3600);
      await c.m.connect(c.owner).unpause();
      expect((await c.m.isLiquidatable(c.pid))[0]).to.equal(false);
      await expect(c.m.connect(c.stranger).liquidatePositionPublic(c.pid))
        .to.be.revertedWithCustomError(c.g, "NotLiquidatableYet");
      await time.increase(GRACE - 60);
      expect((await c.m.isLiquidatable(c.pid))[0]).to.equal(false);
      await time.increase(61);
      const [liq, reason] = await c.m.isLiquidatable(c.pid);
      expect(liq).to.equal(true); expect(reason).to.equal("overdue");
      await expect(c.m.connect(c.stranger).liquidatePositionPublic(c.pid)).to.emit(c.m, "PositionLiquidated");
    });

    it("تصفية هبوط الضمان تبقى فورية بعد الاستئناف", async () => {
      const c = await deploy();
      await c.m.connect(c.owner).pause();
      await time.increase(3600);
      await c.m.connect(c.owner).unpause();
      await c.btcFeed.setAnswer(BTC_FEED / 2n); // ضمان 0.13 BTC يهبط تحت 105% من الدين
      const [liq, reason] = await c.m.isLiquidatable(c.pid);
      expect(liq).to.equal(true); expect(reason).to.equal("undercollateralized");
    });

    it("بلا إيقاف: سلوك Build 22 كما هو (تأخّر بعد الموعد + المهلة)", async () => {
      const c = await deploy();
      await time.increase(Number(INTERVAL) + GRACE + 1);
      expect((await c.m.isLiquidatable(c.pid))[1]).to.equal("overdue");
    });
  });

  describe("الملاءة: المعلّق مُدان به في CustodyLib", () => {
    it("السقف يحتسب USDC المعلّق، والسحب يُنقصه", async () => {
      const c = await deploy();
      await c.usdc.blacklist(c.seller.address);
      const exp0 = await c.m.totalExposureUSDC();
      const amt = await c.m.getInstallmentAmount(c.pid);
      await c.m.connect(c.buyer).payInstallment(c.pid);
      expect(await c.m.totalExposureUSDC()).to.equal(exp0 + amt);
      await c.usdc.unBlacklist(c.seller.address);
      await c.m.connect(c.seller).withdrawToken(c.uAddr);
      expect(await c.m.totalExposureUSDC()).to.equal(exp0);
    });

    it("سحب USDC المعلّق بتجاوز المحاسبة ⇒ قاطع I2 يوقف الإيداع (CustodyInsolvent)", async () => {
      const c = await deploy(true);
      await c.m.connect(c.owner).setCustodyCaps(U(20_000), U(15_000), U(5_000));
      await c.usdc.blacklist(c.seller.address);
      await c.m.connect(c.buyer).payInstallment(c.pid);
      await c.m.forceDrain(c.uAddr, c.stranger.address, 1n);
      await expect(c.m.connect(c.seller2).createOffer(c.wAddr, c.wAddr, c.uAddr, BTC(0.01), 1000, 1, 12, INTERVAL, 0, 12000, false))
        .to.be.revertedWithCustomError(c.g, "CustodyInsolvent");
    });

    it("سكربت المصالحة يعدّ USDC المعلّق مستحقاً (الخانة 30) لا فائضاً", async () => {
      const c = await deploy();
      await c.usdc.blacklist(c.seller.address);
      const amt = await c.m.getInstallmentAmount(c.pid);
      await c.m.connect(c.buyer).payInstallment(c.pid);
      const proxy = await c.m.getAddress();
      expect(await totalPendingToken(ethers.provider, proxy, c.uAddr)).to.equal(amt);
      const p = await planReconciliation(ethers.provider, proxy);
      const row = p.rows.find((r) => r.token === c.uAddr)!;
      expect(row.owed).to.equal(amt);
      expect(row.surplus).to.equal(0n);
      expect(healthOf(p).ok).to.equal(true);
    });
  });
});

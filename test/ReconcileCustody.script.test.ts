import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { deployScenario, BTC, E, INTERVAL } from "./helpers/custodyScenario";
import { linkedFactory, UPG } from "./helpers/linked";
import { planReconciliation, healthOf } from "../scripts/custody-reconcile";

/**
 * scripts/reconcile-custody.ts — النواة planReconciliation على عقد حقيقي (Harness يفرض الخلل).
 * الشروط: docs/global-cap-design.md §4.1 + مراجعة جبتي (المصالحة قبل اعتماد خطة الرجوع).
 */
const ZERO = ethers.ZeroAddress;

async function setup() {
  const c = await deployScenario();
  const h: any = await upgrades.upgradeProxy(c.m, await linkedFactory("MurabahaV6CustodyHarness"), UPG);
  const offer = (who: any, amt: bigint) =>
    h.connect(who).createOffer(c.wAddr, c.wAddr, c.usdc.getAddress(), amt, 1000, 1, 12, INTERVAL, 0, 12000, false);
  const plan = (o: { blockTag?: number; expectedOwner?: string } = {}) =>
    planReconciliation(ethers.provider, c.mAddr, { expectedOwner: c.owner.address, ...o });
  const exec = async (data: string) => c.owner.sendTransaction({ to: c.mAddr, data });
  return { ...c, h, offer, plan, exec };
}
type S = Awaited<ReturnType<typeof setup>>;
const row = (p: any, t: string) => p.rows.find((r: any) => r.token === t);

/** خلل حقيقي: عدّاد ناقص ⇒ خروج يتجاوزه ⇒ accountingFault */
async function fault(s: S) {
  await s.offer(s.seller, BTC(0.1));
  await s.offer(s.seller2, BTC(0.2));
  await s.h.forceOfferCustody(s.wAddr, BTC(0.05));
  await s.h.connect(s.seller).cancelOffer(1);            // 0.1 > 0.05 ⇒ خلل، والعدّاد يصير 0
  expect(await s.h.accountingFault()).to.equal(true);
}

describe("scripts/reconcile-custody — نواة المصالحة", () => {
  it("حالة سليمة: check نظيف، ولا عدّادات تتغيّر", async () => {
    const s = await setup();
    await s.offer(s.seller, BTC(0.1));
    const p = await s.plan();
    expect(healthOf(p).ok).to.equal(true);
    expect(p.changes).to.equal(0);
    expect(p.rows.map((r) => r.token)).to.deep.equal([...(await s.h.getSupportedTokens())]); // لقطة كاملة بترتيب tokenList
  });

  it("خلل + غير موقوف ⇒ check يكشفه، وplan يرفض إخراج أي calldata", async () => {
    const s = await setup(); await fault(s);
    const p = await s.plan();
    const hl = healthOf(p);
    expect(hl.ok).to.equal(false);
    expect(hl.drift.map((r) => r.token)).to.deep.equal([s.wAddr]);
    expect(row(p, s.wAddr).counterOffer).to.equal(0n);
    expect(row(p, s.wAddr).offer).to.equal(BTC(0.2));        // العرض الباقي فقط
    expect(p.blockers.map((b) => b.code)).to.deep.equal(["NOT_PAUSED"]);
    expect(p.data).to.equal(null);
  });

  it("موقوف ⇒ calldata تُحاكى من المالك، والتنفيذ يصحّح كل الرموز ويمسح العلم", async () => {
    const s = await setup(); await fault(s);
    await s.h.connect(s.owner).pause();
    const p = await s.plan();
    expect(p.blockers).to.deep.equal([]);
    expect(p.changes).to.equal(1);
    await s.exec(p.data!);
    expect(await s.h.offerCustody(s.wAddr)).to.equal(BTC(0.2));
    expect(await s.h.accountingFault()).to.equal(false);
    expect(healthOf(await s.plan()).ok).to.equal(true);
    await s.h.connect(s.owner).unpause();
    await s.offer(s.seller, BTC(0.01));                       // الإيداع عاد
    expect(healthOf(await s.plan()).ok).to.equal(true);       // والعدّاد يتابعه
  });

  it("حتمية: نفس الكتلة ⇒ نفس البصمة (مراجعة مستقلة للأرقام)", async () => {
    const s = await setup(); await fault(s);
    await s.h.connect(s.owner).pause();
    const b = await ethers.provider.getBlockNumber();
    const [p1, p2] = [await s.plan({ blockTag: b }), await s.plan({ blockTag: b })];
    expect(p1.dataHash).to.be.a("string");
    expect(p1.dataHash).to.equal(p2.dataHash);
  });

  it("verify: خروج مستخدم بعد اللقطة (cancelOffer مفتوح أثناء الإيقاف) ⇒ البصمة تتغيّر", async () => {
    const s = await setup(); await fault(s);
    await s.h.connect(s.owner).pause();
    const p1 = await s.plan();
    await s.h.connect(s.seller2).cancelOffer(2);              // خروج مسموح أثناء الإيقاف
    const p2 = await s.plan();
    expect(p2.dataHash).to.not.equal(p1.dataHash);
    expect(row(p2, s.wAddr).offer).to.equal(0n);
    // اللقطة القديمة تطلب 0.2 والرصيد صار 0 ⇒ I2 على السلسلة ترفضها كلها
    await expect(s.exec(p1.data!)).to.be.reverted;
    expect(await s.h.accountingFault()).to.equal(true);       // العلم باقٍ
  });

  it("verify إلزامي: مع فائض (تبرّع) تمرّ اللقطة القديمة وتضخّم العدّاد — البصمة وحدها تكشفها", async () => {
    const s = await setup(); await fault(s);
    await s.wbtc.mint(s.mAddr, BTC(0.5));                     // فائض يغطي الفرق
    await s.h.connect(s.owner).pause();
    const p1 = await s.plan();
    await s.h.connect(s.seller2).cancelOffer(2);
    const p2 = await s.plan();
    expect(p2.dataHash).to.not.equal(p1.dataHash);            // verify يرفض
    await s.exec(p1.data!);                                   // لو تجاهلها الموقّع:
    expect(await s.h.offerCustody(s.wAddr)).to.equal(BTC(0.2)); // عدّاد مضخّم (الحقيقة 0)
    expect(healthOf(await s.plan()).drift.length).to.equal(1);  // check يكشف الانحراف بعدها
  });

  it("عجز فعلي (سحب يتجاوز المحاسبة) ⇒ INSOLVENT ولا calldata — تحقيق لا مصالحة", async () => {
    const s = await setup();
    await s.offer(s.seller, BTC(0.1));
    await s.h.forceDrain(s.wAddr, s.stranger.address, BTC(0.03));
    await s.h.connect(s.owner).pause();
    const p = await s.plan();
    expect(p.blockers.map((b) => b.code)).to.deep.equal(["INSOLVENT"]);
    expect(row(p, s.wAddr).surplus).to.equal(-BTC(0.03));
    expect(p.data).to.equal(null);
  });

  it("مالك غير متوقع ⇒ OWNER_MISMATCH", async () => {
    const s = await setup(); await fault(s);
    await s.h.connect(s.owner).pause();
    const p = await s.plan({ expectedOwner: s.stranger.address });
    expect(p.blockers.map((b) => b.code)).to.deep.equal(["OWNER_MISMATCH"]);
    expect(p.data).to.equal(null);
  });

  it("ETH: المستحق يشمل totalPendingETH، والتبرع يظهر فائضاً لا عهدة", async () => {
    const s = await setup();
    await s.h.connect(s.seller).createOffer(ZERO, ZERO, s.usdc.getAddress(), 0, 1000, 1, 12, INTERVAL, 0, 12000, false, { value: E("1") });
    await s.h.forceOfferCustody(ZERO, E("0.4"));
    await s.stranger.sendTransaction({ to: s.mAddr, value: E("0.1") });  // تبرّع
    await s.h.connect(s.owner).pause();
    const p = await s.plan();
    const r = row(p, ZERO);
    expect(r.offer).to.equal(E("1"));
    expect(r.owed).to.equal(E("1") + (await s.h.totalPendingETH()));
    expect(r.surplus).to.equal(E("0.1"));
    expect(p.blockers).to.deep.equal([]);
    await s.exec(p.data!);
    expect(await s.h.offerCustody(ZERO)).to.equal(E("1"));
  });
});

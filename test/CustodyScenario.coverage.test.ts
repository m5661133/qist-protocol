import { expect } from "chai";
import { ethers } from "hardhat";
import { deployScenario, runScenario, recomputeCustody, OPS } from "./helpers/custodyScenario";

/**
 * يثبت — على العقد الحالي، قبل أي تعديل Solidity — أن مولّد السيناريوهات يغطّي فعلاً
 * كل انتقال للعهدة (مراجعة جبتي #4). عند تنفيذ السقف الإجمالي يُعاد استعماله في
 * GlobalCap.design.test.ts #10 مع فحص custodyOf == recomputeCustody بعد كل خطوة.
 */
describe("مولّد سيناريوهات العهدة — تغطية كل المسارات (يعمل الآن)", () => {
  it("كل مسار ينجح مرة على الأقل، مع ETH معلّق، والثابت I2 يصمد", async () => {
    const s = await deployScenario();
    let sawPending = false;
    const ok = await runScenario(s, 20261001, 120, async () => {
      if ((await s.m.totalPendingETH()) > 0n) sawPending = true;
      // I2: الرصيد الفعلي ≥ العهدة المحسوبة من التخزين (+ المعلّق لـETH)
      const ethHeld = await ethers.provider.getBalance(s.mAddr);
      expect(ethHeld).to.be.gte((await recomputeCustody(s, ethers.ZeroAddress)) + (await s.m.totalPendingETH()));
      expect(await s.wbtc.balanceOf(s.mAddr)).to.be.gte(await recomputeCustody(s, s.wAddr));
    });
    for (const op of OPS) expect(ok[op], `المسار ${op} لم ينجح أبداً`).to.be.greaterThan(0);
    expect(sawPending, "لم يظهر ETH معلّق في أي خطوة").to.equal(true);

    // مراجعة جبتي (v2): التغطية بالأسماء لا تكفي — نثبت بلوغ الحالات النهائية فعلاً
    let completedByInstallments = false;
    for (let i = 1n; i < (await s.m.nextPositionId()); i++) {
      const p = await s.m.positions(i);
      if (p.state === 1n && p.paidInstallments === p.totalInstallments && p.collateralAmount === 0n)
        completedByInstallments = true; // اكتمل بالقسط الأخير (earlyRepayCash يضبطها كذلك — لذا نتحقق من الحدث أدناه)
    }
    expect(completedByInstallments).to.equal(true);
    const paid = await s.m.queryFilter(s.m.filters.InstallmentPaid());
    const completedIds = new Set((await s.m.queryFilter(s.m.filters.PositionCompleted())).map((e: any) => e.args[0]));
    const lastInstallment = paid.some((e: any) => e.args[1] === 12n && completedIds.has(e.args[0]));
    expect(lastInstallment, "لم يُدفع قسط أخير يُغلق مركزاً").to.equal(true);
    const reasons = (await s.m.queryFilter(s.m.filters.PositionLiquidated())).map((e: any) => e.args[3]);
    expect(reasons, "لا تصفية بنقص الضمان").to.include("undercollateralized");
    expect(reasons, "لا تصفية بالتأخّر").to.include("overdue");
    console.log("      نجاحات:", JSON.stringify(ok));
  });
});

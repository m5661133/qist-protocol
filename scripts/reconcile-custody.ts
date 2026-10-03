/**
 * reconcile-custody — مصالحة عدّادات العهدة (Build 22) بقيم يوقّعها الـSafe.
 *
 * الأوضاع (MODE):
 *   check  (افتراضي) مراقبة: العدّادات = الحالة؟ I2 سليمة؟ accountingFault؟ — لا يحتاج إيقافاً.
 *                    رمز خروج 1 عند أي انحراف (للتنبيه).
 *   plan   تجهيز المعاملة: يتطلب العقد موقوفاً. يطبع الفرق لكل رمز، ويحاكي الاستدعاء من المالك،
 *          ويطبع معاملة الـSafe وبصمتها، ويحفظ JSON في deployments/reconcile/ للمراجعة.
 *   verify قبل التنفيذ مباشرة (آخر موقّع): EXPECT_HASH=<بصمة plan> — يعيد الحساب على آخر كتلة
 *          ويرفض إن تغيّرت (خروج مستخدم بعد اللقطة). رمز خروج 1 عند الاختلاف.
 *
 *   MODE=plan npx hardhat run scripts/reconcile-custody.ts --network base
 *   MODE=verify EXPECT_HASH=0x… npx hardhat run scripts/reconcile-custody.ts --network base
 *   BLOCK=<رقم> لتثبيت كتلة اللقطة (plan/check) — للمراجعة المستقلة لنفس الأرقام.
 *
 * لا يرسل أي معاملة. التنفيذ يدوي من app.safe.global بتوقيعين.
 * docs/global-cap-design.md §4.1 · scripts/custody-reconcile.ts (النواة المختبرة)
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { PROXY, EXPECTED_OWNER } from "./build22-upgrade";
import { planReconciliation, healthOf, Plan } from "./custody-reconcile";

const NAMES: Record<string, string> = {
  [ethers.ZeroAddress]: "ETH",
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "cbBTC",
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
};
const name = (t: string) => NAMES[t.toLowerCase()] ?? NAMES[t] ?? t;

function printRows(p: Plan) {
  console.log(`  كتلة ${p.block} · موقوف ${p.paused} · accountingFault ${p.accountingFault} · المالك ${p.owner}`);
  console.log("  الرمز   | العدّاد عروض → الصحيح | العدّاد ضمان → الصحيح | الرصيد | المستحق | الفائض");
  for (const r of p.rows) {
    const mark = (a: bigint, b: bigint) => (a === b ? `${b}` : `${a} → ${b} ⚠️`);
    console.log(`  ${name(r.token).padEnd(7)} | ${mark(r.counterOffer, r.offer)} | ${mark(r.counterCollateral, r.collateral)} | ${r.balance} | ${r.owed} | ${r.surplus}`);
  }
}

async function main() {
  const mode = (process.env.MODE ?? "check").toLowerCase();
  const proxy = process.env.PROXY_ADDRESS ?? PROXY;
  const blockTag = process.env.BLOCK ? Number(process.env.BLOCK) : undefined;
  const plan = await planReconciliation(ethers.provider, proxy, { blockTag, expectedOwner: process.env.EXPECTED_OWNER ?? EXPECTED_OWNER });

  console.log(`🧮 مصالحة العهدة — وضع ${mode} — ${proxy} (chainId ${plan.chainId})`);
  printRows(plan);

  if (mode === "check") {
    const h = healthOf(plan);
    console.log(h.ok ? "\n✅ العدّادات مطابقة للحالة، I2 سليمة، لا خلل محاسبي"
      : `\n🔴 انحراف: ${h.drift.length} رمز · عجز: ${h.insolvent.length} · accountingFault ${plan.accountingFault}`);
    if (!h.ok) process.exitCode = 1;
    return;
  }

  if (plan.blockers.length) {
    console.log("\n⛔ لا معاملة:");
    for (const b of plan.blockers) console.log(`   ${b.code}: ${b.detail}`);
    if (plan.blockers.some((b) => b.code === "NOT_PAUSED")) console.log("   ⇒ أوقف العقد من الـSafe (pause) ثم أعد التشغيل.");
    process.exitCode = 1;
    return;
  }

  if (mode === "verify") {
    const want = process.env.EXPECT_HASH;
    if (!want) throw new Error("⛔ verify يحتاج EXPECT_HASH من مخرجات plan");
    const same = plan.dataHash === want.toLowerCase();
    console.log(same ? `\n✅ البصمة مطابقة ${plan.dataHash} — نفّذ المعاملة الآن`
      : `\n🔴 البصمة تغيّرت: ${plan.dataHash} ≠ ${want}\n   تغيّرت الحالة بعد اللقطة (خروج مستخدم) — لا تنفّذ؛ أعد plan ووقّع المعاملة الجديدة`);
    if (!same) process.exitCode = 1;
    return;
  }

  if (mode !== "plan") throw new Error(`⛔ وضع غير معروف: ${mode}`);
  if (!plan.changes && !plan.accountingFault) console.log("\nℹ️  العدّادات مطابقة أصلاً ولا خلل — المصالحة غير لازمة.");
  console.log("\n────── معاملة الـSafe (app.safe.global → Transaction Builder) ──────");
  console.log("  To    :", proxy);
  console.log("  Value : 0");
  console.log("  Data  :", plan.data);
  console.log("  بصمة  :", plan.dataHash);
  console.log("────────────────────────────────────────────────────────────────────");
  console.log(`محاكاة من المالك عند الكتلة ${plan.block}: ✅ نجحت`);
  console.log("قبل التنفيذ مباشرة (آخر موقّع):");
  console.log(`  MODE=verify EXPECT_HASH=${plan.dataHash} npx hardhat run scripts/reconcile-custody.ts --network <الشبكة>`);
  console.log("بعد التنفيذ: MODE=check ثم unpause من الـSafe.");

  const dir = path.join(__dirname, "../deployments/reconcile");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${plan.chainId}-${plan.block}.json`);
  fs.writeFileSync(file, JSON.stringify(plan, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  console.log(`حُفظت اللقطة: ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

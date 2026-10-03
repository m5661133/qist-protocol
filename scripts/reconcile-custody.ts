/**
 * reconcile-custody — مصالحة عدّادات العهدة (Build 22) بقيم يوقّعها الـSafe.
 *
 * الأوضاع (MODE):
 *   check  (افتراضي) مراقبة: العدّادات = الحالة؟ I2 سليمة؟ accountingFault؟ الشبكة والمالك؟ — لا يحتاج إيقافاً.
 *                    رمز خروج 1 عند أي انحراف (للتنبيه). مع BLOCK: مراجعة تاريخية فقط، بلا أي إذن فتح.
 *   ready  بوابة إعادة الفتح بعد المصالحة: أحدث كتلة فقط (BLOCK مرفوض) + شبكة ومالك متوقعان +
 *          موقوف + حسابات سليمة. exit 0 = يجوز unpause. (B6-REC-03)
 *   plan   تجهيز المعاملة: يتطلب العقد موقوفاً. يطبع الفرق لكل رمز، ويحاكي الاستدعاء من المالك،
 *          ويطبع معاملة الـSafe وبصمتها، ويحفظ JSON في deployments/reconcile/ للمراجعة.
 *   verify قبل التنفيذ مباشرة (آخر موقّع): EXPECT_HASH=<بصمة plan> — يعيد الحساب على **أحدث كتلة**
 *          (BLOCK مرفوض هنا) ويرفض إن تغيّرت. البصمة تشمل chainId وproxy وvalue وcalldata.
 *          النجاح لا يقفل الحالة حتى التنفيذ ⇒ check بعد التنفيذ إلزامي، ولا unpause إلا إن نجح.
 *
 *   MODE=plan npx hardhat run scripts/reconcile-custody.ts --network base
 *   MODE=verify EXPECT_HASH=0x… npx hardhat run scripts/reconcile-custody.ts --network base
 *   BLOCK=<رقم> لتثبيت كتلة اللقطة (plan/check فقط) — للمراجعة المستقلة لنفس الأرقام، لا لقرار التنفيذ أو الفتح.
 *
 * لا يرسل أي معاملة. التنفيذ يدوي من app.safe.global بتوقيعين.
 * docs/global-cap-design.md §4.1 · scripts/custody-reconcile.ts (النواة المختبرة)
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { PROXY, EXPECTED_OWNER } from "./build22-upgrade";
import { planReconciliation, verifyPlan, unpauseReadiness, readinessOf, Plan } from "./custody-reconcile";

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
  const expectedOwner = process.env.EXPECTED_OWNER ?? EXPECTED_OWNER;

  if (mode === "verify") {
    // B6-REC-01: أحدث كتلة فقط
    if (blockTag !== undefined) throw new Error("⛔ verify لا يقبل BLOCK — يتحقق من أحدث كتلة فقط. أزل BLOCK وأعد التشغيل.");
    const want = process.env.EXPECT_HASH;
    if (!want) throw new Error("⛔ verify يحتاج EXPECT_HASH من مخرجات plan");
    const v = await verifyPlan(ethers.provider, proxy, want, { expectedOwner });
    console.log(`🧮 مصالحة العهدة — وضع verify — ${proxy} (chainId ${v.plan.chainId})`);
    console.log(`  أحدث كتلة ${v.block} · ${new Date(v.timestamp * 1000).toISOString()}`);
    printRows(v.plan);
    if (v.plan.blockers.length) {
      console.log("\n⛔ لا معاملة:"); for (const b of v.plan.blockers) console.log(`   ${b.code}: ${b.detail}`);
      process.exitCode = 1; return;
    }
    console.log(v.match ? `\n✅ البصمة مطابقة ${v.plan.fingerprint} — نفّذ المعاملة الآن، ثم MODE=ready قبل أي unpause`
      : `\n🔴 البصمة تغيّرت: ${v.plan.fingerprint} ≠ ${want}\n   تغيّرت الحالة أو الشبكة أو العنوان — لا تنفّذ؛ أعد plan ووقّع المعاملة الجديدة`);
    if (!v.match) process.exitCode = 1;
    return;
  }

  if (mode === "ready") {
    // B6-REC-03: بوابة الفتح — أحدث كتلة فقط
    if (blockTag !== undefined) throw new Error("⛔ ready لا يقبل BLOCK — بوابة الفتح تفحص أحدث كتلة فقط.");
    const r = await unpauseReadiness(ethers.provider, proxy, { expectedOwner });
    console.log(`🧮 بوابة إعادة الفتح — ${proxy} (chainId ${r.plan.chainId})`);
    console.log(`  أحدث كتلة ${r.block} · ${new Date(r.timestamp * 1000).toISOString()}`);
    printRows(r.plan);
    console.log(r.ready ? "\n✅ جاهز: يجوز unpause من الـSafe الآن."
      : `\n⛔ لا unpause:\n${r.reasons.map((x) => "   " + x).join("\n")}`);
    if (!r.ready) process.exitCode = 1;
    return;
  }

  const plan = await planReconciliation(ethers.provider, proxy, { blockTag, expectedOwner });

  console.log(`🧮 مصالحة العهدة — وضع ${mode} — ${proxy} (chainId ${plan.chainId})`);
  printRows(plan);

  if (mode === "check") {
    const r = readinessOf(plan);
    const env = plan.blockers.filter((b) => b.code === "WRONG_CHAIN" || b.code === "OWNER_MISMATCH");
    const ok = r.health.ok && env.length === 0;
    if (blockTag !== undefined) console.log(`  ⚠️ لقطة تاريخية (BLOCK=${blockTag}) — للمراجعة فقط، لا تصلح لقرار الفتح`);
    console.log(ok ? "\n✅ العدّادات مطابقة للحالة، I2 سليمة، لا خلل محاسبي، الشبكة والمالك كما يُتوقع"
      : `\n🔴 ${[...env.map((b) => b.code), r.health.drift.length ? `انحراف ${r.health.drift.length}` : "", r.health.insolvent.length ? `عجز ${r.health.insolvent.length}` : "", plan.accountingFault ? "accountingFault" : ""].filter(Boolean).join(" · ")}`);
    if (plan.paused) console.log("   العقد موقوف — قرار الفتح عبر MODE=ready (أحدث كتلة) لا عبر check.");
    if (!ok) process.exitCode = 1;
    return;
  }

  if (plan.blockers.length) {
    console.log("\n⛔ لا معاملة:");
    for (const b of plan.blockers) console.log(`   ${b.code}: ${b.detail}`);
    if (plan.blockers.some((b) => b.code === "NOT_PAUSED")) console.log("   ⇒ أوقف العقد من الـSafe (pause) ثم أعد التشغيل.");
    process.exitCode = 1;
    return;
  }

  if (mode !== "plan") throw new Error(`⛔ وضع غير معروف: ${mode}`);
  if (!plan.changes && !plan.accountingFault) console.log("\nℹ️  العدّادات مطابقة أصلاً ولا خلل — المصالحة غير لازمة.");
  console.log("\n────── معاملة الـSafe (app.safe.global → Transaction Builder) ──────");
  console.log("  To    :", proxy);
  console.log("  Value : 0");
  console.log("  Data  :", plan.data);
  console.log(`  بصمة  : ${plan.fingerprint}   (keccak256(abi.encode(chainId ${plan.chainId}, to, value 0, data)))`);
  console.log("────────────────────────────────────────────────────────────────────");
  console.log(`محاكاة من المالك عند الكتلة ${plan.block}: ✅ نجحت`);
  console.log("قبل التنفيذ مباشرة (آخر موقّع):");
  console.log(`  MODE=verify EXPECT_HASH=${plan.fingerprint} npx hardhat run scripts/reconcile-custody.ts --network <الشبكة>   (بلا BLOCK)`);
  console.log("بعد التنفيذ: MODE=ready (أحدث كتلة) — ولا unpause من الـSafe إلا إن نجح (exit 0).");

  const dir = path.join(__dirname, "../deployments/reconcile");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${plan.chainId}-${plan.block}.json`);
  fs.writeFileSync(file, JSON.stringify(plan, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  console.log(`حُفظت اللقطة: ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

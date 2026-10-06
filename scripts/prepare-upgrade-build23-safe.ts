import { ethers, network } from "hardhat";
import { PROXY, proxyImpl, proxyInitVersion } from "./build22-upgrade";
import { preflight23, deployBuild23, validateAgainstBuild22, upgradeCalldata23, REUSED } from "./build23-upgrade";
import { planReconciliation, healthOf } from "./custody-reconcile";

/**
 * تجهيز ترقية Build 23 — للـProxy المملوك لـSafe 2-of-3. تقرير: ايجنت اسلامي/05_تقرير_ثغرة_قسط.md
 *
 *   تجربة جافة: FORK_BLOCK=<كتلة> npx hardhat --config hardhat.fork.config.ts run scripts/prepare-upgrade-build23-safe.ts
 *   الشبكة:     npx hardhat run scripts/prepare-upgrade-build23-safe.ts --network base   ← لا يُشغَّل إلا بقرار المالك
 *   تحقق بعد النشر (لا نشر): LIB_CustodyLib=<…> IMPL_BUILD23=<…> + أمر التجربة الجافة
 *
 * لا يلمس الـProxy على الشبكة: ينشر CustodyLib الجديدة ثم التنفيذ المربوط (المكتبات الثلاث الأخرى من Build 22)،
 * يتحقق من الكود والتخزين ضد Build 22 الحي، ثم يطبع معاملة الـSafe: upgradeToAndCall(impl, 0x).
 * في التجربة الجافة فقط: ينفّذ المعاملة من الـSafe على النسخة المحلية ويفحص النتيجة.
 */
const results: [string, boolean][] = [];
const ok = (n: string, c: boolean) => { results.push([n, c]); console.log(`  ${c ? "✅" : "🔴"} ${n}`); };

async function main() {
  const net = await ethers.provider.getNetwork();
  const dry = net.chainId === 31337n;
  if (dry) await network.provider.send("hardhat_mine", ["0x1"]); // كتلة التفرّع تُعامل كتاريخية في EDR
  console.log(dry ? "🧪 تجربة جافة على نسخة محلية — لا شيء يُرسل إلى Base\n" : `⚠️ شبكة حقيقية chainId=${net.chainId}\n`);

  const pf = await preflight23();
  console.log(`  ما قبل النشر ✅ chainId ${pf.chainId} · Build 22 ${pf.impl} · بصمة مطابقة · تهيئة ${pf.ver} · المالك ${pf.owner}`);

  const { libs, implAddr, sizes, Factory } = await deployBuild23();
  for (const L of ["CustodyLib", ...REUSED, "MurabahaV6"])
    console.log(`  ${L.padEnd(16)} ${String(sizes[L]).padStart(6)} بايت  ${L === "MurabahaV6" ? implAddr : libs[L]}  ✅ الكود مطابق${(REUSED as readonly string[]).includes(L) ? " (مُعادة من Build 22)" : ""}`);
  await validateAgainstBuild22(Factory);
  console.log("  الكود الحي = legacy/b22 · التخزين متوافق مع Build 22 الحي ✅");

  await preflight23(); // لم يتغيّر شيء أثناء النشر
  const data = upgradeCalldata23(implAddr);
  console.log("\n────── معاملة الـSafe (app.safe.global → Transaction Builder) ──────");
  console.log("  To    :", PROXY);
  console.log("  Value : 0");
  console.log("  Data  :", data);
  console.log(`  = upgradeToAndCall(${implAddr}, 0x)`);
  console.log("──────────────────────────────────────────────────────────────────");

  if (!dry) {
    console.log("\nسجّل العناوين في deployments/build23-base.json، ثم أعد هذا السكربت تجربةً جافة مع");
    console.log(`  LIB_CustodyLib=${libs.CustodyLib} IMPL_BUILD23=${implAddr}  — يجب أن تنجح كل الفحوص قبل التوقيع.`);
    console.log("\nتوثيق Basescan:");
    console.log(`  npx hardhat verify --network base ${libs.CustodyLib}`);
    console.log(`  npx hardhat verify --network base ${implAddr}  # مع --libraries`);
    return;
  }

  // ═══ التجربة الجافة: تنفيذ المعاملة من الـSafe على النسخة المحلية ═══
  console.log("\n🔱 تنفيذ المعاملة من الـSafe على النسخة المحلية");
  const r = new ethers.Contract(PROXY, [
    "function nextOfferId() view returns (uint256)", "function nextPositionId() view returns (uint256)",
    "function owner() view returns (address)", "function paused() view returns (bool)",
    "function globalCapUSDC() view returns (uint256)", "function commitmentCapUSDC() view returns (uint256)",
    "function offerCapUSDC() view returns (uint256)", "function totalExposureUSDC() view returns (uint256)",
    "function guardian() view returns (address)", "function keeper() view returns (address)",
    "function activePositionsCount() view returns (uint256)", "function accountingFault() view returns (bool)",
    "function pendingToken(address,address) view returns (uint256)", "function withdrawToken(address)",
  ], ethers.provider);
  const snap = async () => [
    await r.nextOfferId(), await r.nextPositionId(), await r.owner(), await r.paused(),
    await r.globalCapUSDC(), await r.commitmentCapUSDC(), await r.offerCapUSDC(), await r.totalExposureUSDC(),
    await r.guardian(), await r.keeper(), await r.activePositionsCount(), await r.accountingFault(),
    await ethers.provider.getBalance(PROXY),
  ].map(String);
  const before = await snap();

  await network.provider.request({ method: "hardhat_impersonateAccount", params: [pf.owner] });
  await network.provider.send("hardhat_setBalance", [pf.owner, "0x56BC75E2D63100000"]);
  const rc = await (await (await ethers.getSigner(pf.owner)).sendTransaction({ to: PROXY, value: 0n, data })).wait();
  ok(`التنفيذ من الـSafe نجح (غاز ${rc!.gasUsed})`, rc!.status === 1);
  ok("التنفيذ = Build 23 · التهيئة باقية 3 (بلا initializer)", (await proxyImpl()) === implAddr.toLowerCase() && (await proxyInitVersion()) === 3n);
  const after = await snap();
  const names = ["nextOfferId", "nextPositionId", "owner", "paused", "globalCap", "commitmentCap", "offerCap",
    "totalExposureUSDC", "guardian", "keeper", "activePositions", "accountingFault", "ETH balance"];
  const diff = names.filter((_, i) => before[i] !== after[i]).map((n) => `${n}: ${before[names.indexOf(n)]} → ${after[names.indexOf(n)]}`);
  ok("العروض والمراكز والمالك والإيقاف والحدود والعهدة والحارس والمنفّذ ورصيد ETH كما هي", diff.length === 0);
  if (diff.length) console.log("     اختلف:", diff.join(" · "));
  const p = await planReconciliation(ethers.provider, PROXY, { expectedOwner: pf.owner });
  ok("العدّادات = الحالة لكل رمز، I2 سليمة، لا خلل (reconcile check)", healthOf(p).ok);
  const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  ok("R-1 حاضر: pendingToken يُقرأ (صفر)", (await r.pendingToken(usdc, pf.owner)) === 0n);
  let zeroRevert = false;
  try { await r.connect(await ethers.getSigner(pf.owner)).withdrawToken.staticCall(usdc); } catch { zeroRevert = true; }
  ok("withdrawToken بلا مستحق يُرفض", zeroRevert);

  const failed = results.filter(([, v]) => !v);
  console.log(`\n═══ ${results.length - failed.length}/${results.length} ═══`);
  console.log(failed.length ? "🔴 لا توقيع" : "✅ المعاملة جاهزة — السيناريوهات الوظيفية: test/foundry/Build23Fork.t.sol");
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

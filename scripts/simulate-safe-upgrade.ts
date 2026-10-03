/**
 * simulate-safe-upgrade — محاكاة معاملة الـSafe **النهائية** (من deployments/build22-base.json) على نسخة Base.
 *
 *   FORK_BLOCK=<كتلة حديثة> npx hardhat --config hardhat.fork.config.ts run scripts/simulate-safe-upgrade.ts
 *
 * لا نشر هنا: يستخدم التنفيذ والمكتبات المنشورة فعلاً، ويتحقق أن كودها = المُجمَّع، وأن Data المسجّلة
 * = upgradeToAndCall(التنفيذ المنشور, initializeV3(20k,15k,5k))، ثم ينفّذها من الـSafe على النسخة ويفحص النتيجة.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { PROXY, CAPS, preflight, verifyDeployed, validateAgainstBuild21, upgradeCalldata, proxyImpl, proxyInitVersion } from "./build22-upgrade";
import { planReconciliation, healthOf } from "./custody-reconcile";

const results: [string, boolean][] = [];
const ok = (n: string, c: boolean) => { results.push([n, c]); console.log(`  ${c ? "✅" : "🔴"} ${n}`); };

async function main() {
  if ((await ethers.provider.getNetwork()).chainId !== 31337n) throw new Error("⛔ محاكاة محلية فقط");
  await network.provider.send("hardhat_mine", ["0x1"]);
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "../deployments/build22-base.json"), "utf8"));
  const impl = d.build22.implementation, libs = d.build22.libraries, tx = d.build22.safeTx;
  console.log(`🔱 محاكاة معاملة الـSafe النهائية — كتلة ${await ethers.provider.getBlockNumber()}`);

  const pf = await preflight();
  ok("preflight: Build 21 الحي، بصمة مطابقة، تهيئة 1، المالك الـSafe", true);
  const sizes = await verifyDeployed(libs, impl);
  ok(`الكود المنشور = المُجمَّع (MurabahaV6 ${sizes.MurabahaV6} بايت + 4 مكتبات)`, true);
  await validateAgainstBuild21(await ethers.getContractFactory("MurabahaV6", { libraries: libs }));
  ok("توافق التخزين مع Build 21 الحي", true);
  ok("Data المسجّلة = upgradeToAndCall(المنشور, initializeV3(20k,15k,5k))", tx.data === upgradeCalldata(impl, CAPS) && tx.to === PROXY && tx.value === "0");

  const r = new ethers.Contract(PROXY, [
    "function nextOfferId() view returns (uint256)", "function nextPositionId() view returns (uint256)",
    "function owner() view returns (address)", "function paused() view returns (bool)",
    "function globalCapUSDC() view returns (uint256)", "function commitmentCapUSDC() view returns (uint256)",
    "function offerCapUSDC() view returns (uint256)", "function totalExposureUSDC() view returns (uint256)",
  ], ethers.provider);
  const before = [await r.nextOfferId(), await r.nextPositionId(), await r.owner(), await r.paused(), await ethers.provider.getBalance(PROXY)];

  await network.provider.request({ method: "hardhat_impersonateAccount", params: [pf.owner] });
  await network.provider.send("hardhat_setBalance", [pf.owner, "0x56BC75E2D63100000"]);
  const rc = await (await (await ethers.getSigner(pf.owner)).sendTransaction({ to: tx.to, value: 0n, data: tx.data })).wait();
  ok(`التنفيذ من الـSafe نجح (غاز ${rc!.gasUsed})`, rc!.status === 1);
  ok("التنفيذ = Build 22 المنشور · تهيئة 3", (await proxyImpl()) === impl.toLowerCase() && (await proxyInitVersion()) === 3n);
  const after = [await r.nextOfferId(), await r.nextPositionId(), await r.owner(), await r.paused(), await ethers.provider.getBalance(PROXY)];
  ok("العروض والمراكز والمالك والإيقاف ورصيد ETH كما هي", JSON.stringify(before, (_, v) => String(v)) === JSON.stringify(after, (_, v) => String(v)));
  ok("الحدود 20,000 / 15,000 / 5,000", (await r.globalCapUSDC()) === CAPS.global && (await r.commitmentCapUSDC()) === CAPS.commitment && (await r.offerCapUSDC()) === CAPS.offer);
  const p = await planReconciliation(ethers.provider, PROXY, { expectedOwner: pf.owner });
  ok("العدّادات المرحّلة = الحالة لكل رمز، I2 سليمة، لا خلل (reconcile check)", healthOf(p).ok);
  console.log(`     إجمالي العهدة بعد الترقية $${ethers.formatUnits(await r.totalExposureUSDC(), 6)}`);

  const failed = results.filter(([, v]) => !v);
  console.log(`\n═══ ${results.length - failed.length}/${results.length} ═══`);
  console.log(failed.length ? "🔴 لا توقيع" : "✅ المعاملة النهائية جاهزة للتوقيع");
  if (failed.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exit(1); });

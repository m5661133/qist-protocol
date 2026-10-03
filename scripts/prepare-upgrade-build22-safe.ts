import { ethers, network } from "hardhat";
import { PROXY, CAPS, LIBS, preflight, deployBuild22, validateAgainstBuild21, upgradeCalldata } from "./build22-upgrade";

/**
 * تجهيز ترقية Build 22 (السقف الإجمالي + المكتبات الخارجية) — للـProxy المملوك لـSafe 2-of-3.
 *
 *   تجربة جافة: FORK_BLOCK=<كتلة> npx hardhat --config hardhat.fork.config.ts run scripts/prepare-upgrade-build22-safe.ts
 *   الشبكة:     npx hardhat run scripts/prepare-upgrade-build22-safe.ts --network base   ← لا يُشغَّل إلا بقرار المالك
 *
 * لا يلمس الـProxy: ينشر المكتبات الأربع ثم التنفيذ المربوط، ويتحقق أن كود كلٍّ منها على
 * السلسلة = المُجمَّع محلياً، ويتحقق من التخزين ضد Build 21 **الفعلي** (لا forceImport بالمصنع الجديد)،
 * ثم يطبع معاملة الـSafe: upgradeToAndCall(impl, initializeV3(20k, 15k, 5k)) — ترقية وترحيل ذرّيان.
 */
async function main() {
  const net = await ethers.provider.getNetwork();
  const dry = net.chainId === 31337n;
  // كتلة التفرّع نفسها تُعامل كتاريخية في EDR؛ كتلة محلية واحدة تكفي (التجربة الجافة فقط)
  if (dry) await network.provider.send("hardhat_mine", ["0x1"]);
  console.log(dry ? "🧪 تجربة جافة على نسخة محلية — لا شيء يُرسل إلى Base\n" : `⚠️ شبكة حقيقية chainId=${net.chainId}\n`);

  // B6-UPG-01: قبل نشر أي مكتبة
  const pf = await preflight();
  console.log(`  ما قبل النشر ✅ chainId ${pf.chainId} · تنفيذ ${pf.impl} · بصمة مطابقة · تهيئة ${pf.ver} · المالك ${pf.owner}`);

  const { libs, implAddr, sizes, Factory } = await deployBuild22();
  for (const L of [...LIBS, "MurabahaV6"])
    console.log(`  ${L.padEnd(16)} ${String(sizes[L]).padStart(6)} بايت  ${L === "MurabahaV6" ? implAddr : libs[L]}  ✅ الكود مطابق`);
  await validateAgainstBuild21(Factory);
  console.log("  التخزين متوافق مع Build 21 الحي ✅");

  await preflight(); // لم يتغيّر شيء أثناء النشر
  const data = upgradeCalldata(implAddr);
  console.log("\n────── معاملة الـSafe (app.safe.global → Transaction Builder) ──────");
  console.log("  To    :", PROXY);
  console.log("  Value : 0");
  console.log("  Data  :", data);
  console.log(`  = upgradeToAndCall(${implAddr}, initializeV3(${CAPS.global}, ${CAPS.commitment}, ${CAPS.offer}))`);
  console.log("──────────────────────────────────────────────────────────────────");
  console.log("قبل التوقيع: محاكاة Tenderly من واجهة الـSafe يجب أن تنجح، وscripts/fork-upgrade-build22.ts كاملة (40/40) على كتلة حديثة.");
  if (!dry) {
    console.log("\nتوثيق Basescan (المكتبات أولاً):");
    for (const L of LIBS) console.log(`  npx hardhat verify --network base ${libs[L]}`);
    console.log(`  npx hardhat verify --network base ${implAddr}  # مع --libraries`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

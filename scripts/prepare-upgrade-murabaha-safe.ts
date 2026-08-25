import hre, { ethers, upgrades } from "hardhat";

/**
 * تجهيز ترقية MurabahaV6 (Build 21) على Base — للـProxy المملوك لـ Safe 2-of-3.
 *
 *   npx hardhat run scripts/prepare-upgrade-murabaha-safe.ts --network base
 *
 * لا يلمس الـProxy: يتحقّق من توافق التخزين، ثم ينشر implementation جديداً فقط،
 * ويطبع معاملة الـSafe الواجب تنفيذها يدوياً (upgradeToAndCall) — لأن المالك Safe
 * ويحتاج توقيعين، ولا يمكن تنفيذها من سطر الأوامر.
 */

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";

async function main() {
  const [signer] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory("MurabahaV6");
  const opts = { kind: "uups" as const, unsafeAllow: ["constructor" as const] };

  const proxy: any = Factory.attach(PROXY);
  const owner = await proxy.owner();
  console.log("الموقّع        :", signer.address);
  console.log("مالك الـProxy  :", owner, "(Safe — التنفيذ من واجهة Safe)");
  console.log("العروض/المراكز :", (await proxy.nextOfferId()).toString(), "/", (await proxy.nextPositionId()).toString());

  // manifest الـOZ لا يعرف هذا الـproxy (نُشر Build 19 بمسار آخر) — سجّله أولاً
  console.log("\n⏳ تسجيل الـproxy في manifest الـOZ (forceImport) ...");
  await upgrades.forceImport(PROXY, Factory, { kind: "uups" });
  console.log("✅ مُسجَّل.");

  console.log("\n⏳ التحقّق من توافق التخزين مع المنشور ...");
  await upgrades.validateUpgrade(PROXY, Factory, opts);
  console.log("✅ تخطيط التخزين متوافق.");

  // ⚠️ لا نستخدم prepareUpgrade هنا: forceImport أعلاه يسجّل عنوان الـimplementation
  //    المنشور تحت بصمة البايت-كود **المحلي**، فيعيد prepareUpgrade العنوان القديم
  //    بلا نشر — ترقية وهمية تبدو ناجحة. ننشر مباشرةً ونتحقّق من البايت-كود.
  console.log("\n⏳ نشر implementation جديد مباشرةً (بلا مساس بالـProxy) ...");
  const deployed = await Factory.deploy();
  await deployed.waitForDeployment();
  const implAddr = await deployed.getAddress();
  console.log("✅ Implementation الجديد:", implAddr);

  // تحقّق: البايت-كود على السلسلة يطابق المُجمَّع محلياً، ويختلف عن المنشور حالياً
  const artifact = await hre.artifacts.readArtifact("MurabahaV6");
  const onchain = await ethers.provider.getCode(implAddr);
  const currentImpl = await upgrades.erc1967.getImplementationAddress(PROXY);
  // UUPSUpgradeable فيه `immutable __self = address(this)` فيُخبز العنوان في البايت-كود
  // المنشور بينما هو أصفار في الـartifact — نصفّره قبل المقارنة.
  const zeroed = onchain.toLowerCase().split(implAddr.toLowerCase().slice(2)).join("0".repeat(40));
  if (zeroed !== artifact.deployedBytecode.toLowerCase()) {
    throw new Error("⛔ البايت-كود المنشور لا يطابق المُجمَّع محلياً");
  }
  if (implAddr.toLowerCase() === currentImpl.toLowerCase()) {
    throw new Error("⛔ العنوان الجديد = المنشور حالياً — لا تغيير فعلي");
  }
  console.log("   البايت-كود مطابق للمُجمَّع محلياً ✅ ومختلف عن المنشور", currentImpl, "✅");

  // معاملة الـSafe: upgradeToAndCall(newImplementation, "")
  const iface = new ethers.Interface([
    "function upgradeToAndCall(address newImplementation, bytes data) payable",
  ]);
  const data = iface.encodeFunctionData("upgradeToAndCall", [implAddr, "0x"]);

  console.log("\n────── معاملة الـSafe (نفّذها من app.safe.global) ──────");
  console.log("  To    :", PROXY);
  console.log("  Value : 0");
  console.log("  Data  :", data);
  console.log("──────────────────────────────────────────────────────");
  console.log("\nبعد التنفيذ، وثّق على Basescan:");
  console.log(`  npx hardhat verify --network base ${implAddr}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

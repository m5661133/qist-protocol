/**
 * ترقية آمنة لـ MurabahaV6 على Base — تعالج H1 + H2 + M4.
 *
 * يستخدم upgrades.upgradeProxy/validateUpgrade من OpenZeppelin (لا upgradeToAndCall يدوي)،
 * فيتحقّق من توافق تخطيط التخزين مع Build 16 المنشور ويرفض الترقية إن كانت غير آمنة.
 *
 * الوضع الافتراضي = تحقّق فقط (قراءة، بلا نشر). للترقية الفعلية: DO_UPGRADE=1 + PRIVATE_KEY للمالك.
 *
 *   تحقّق فقط:   npx hardhat run scripts/upgrade_base_safe.ts --network base
 *   ترقية فعلية: DO_UPGRADE=1 npx hardhat run scripts/upgrade_base_safe.ts --network base
 */
import { ethers, upgrades } from "hardhat";

// Proxy ثابت للأبد على Base
const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";

// ⚠️ أكّد هذا العنوان من توثيق Chainlink (Base L2 Sequencer Uptime Feed) قبل الضبط الفعلي
const BASE_SEQUENCER_FEED = "0xBCF85224fc0756B9Fa45aA7892530B47e10b6433";

async function main() {
  const Factory = await ethers.getContractFactory("MurabahaV6");
  const opts = { kind: "uups" as const, unsafeAllow: ["constructor" as const] };

  // (1) تحقّق توافق التخزين مع المنشور — يرمي خطأً إن كان غير آمن (M4)
  console.log("⏳ التحقّق من توافق التخزين مع Build 16 على Base ...");
  await upgrades.validateUpgrade(PROXY, Factory, opts);
  console.log("✅ تخطيط التخزين متوافق — الترقية آمنة storage-wise.");

  if (process.env.DO_UPGRADE !== "1") {
    console.log("ℹ️ وضع التحقّق فقط (لا نشر). للترقية الفعلية: DO_UPGRADE=1 + PRIVATE_KEY.");
    return;
  }

  // (2) الترقية الفعلية عبر المسار الآمن
  console.log("⏳ نشر implementation جديد وترقية الـ Proxy ...");
  const upgraded = await upgrades.upgradeProxy(PROXY, Factory, opts);
  await upgraded.waitForDeployment();
  const impl = await upgrades.erc1967.getImplementationAddress(PROXY);
  console.log("✅ تمّت الترقية. Implementation الجديد:", impl);

  // (3) تحقّق أن feed السيكوينسر يستجيب على السلسلة قبل ضبطه (مراجعة المرحلة 9)
  console.log("⏳ التحقّق من feed السيكوينسر ...");
  const seqFeed = await ethers.getContractAt("IChainlinkFeed", BASE_SEQUENCER_FEED);
  const rd = await seqFeed.latestRoundData();
  console.log("   feed يستجيب — answer:", rd[1].toString(), "· startedAt:", rd[2].toString());

  // (4) تفعيل فحص الـ sequencer (H2) — بدونه يبقى الفحص متخطّى
  console.log("⏳ ضبط sequencerUptimeFeed ...");
  const tx = await (upgraded as any).setSequencerUptimeFeed(BASE_SEQUENCER_FEED);
  await tx.wait();
  console.log("✅ ضُبط sequencerUptimeFeed:", BASE_SEQUENCER_FEED);
  console.log("📝 حدّث Implementation address في ../CLAUDE.md");
}

main().catch((e) => { console.error(e); process.exit(1); });

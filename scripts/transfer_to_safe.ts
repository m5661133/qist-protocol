/**
 * transfer_to_safe — نقل ملكية MurabahaV6 Proxy إلى Safe 2-of-3 على Base.
 * ⚠️ فعل لا رجعة فيه. يتحقق من شروط الأمان قبل التنفيذ.
 *   npx hardhat run scripts/transfer_to_safe.ts --network base
 */
import { ethers } from "hardhat";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const SAFE  = "0x64D738021BAe4cb9a7fd82529C2F94f61d404064";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("🔐 نقل ملكية Qist إلى Safe 2-of-3");
  console.log("الناشر:", deployer.address);

  const proxy = new ethers.Contract(PROXY, [
    "function owner() view returns (address)",
    "function transferOwnership(address)",
  ], deployer);
  const safe = new ethers.Contract(SAFE, [
    "function nonce() view returns (uint256)",
    "function getThreshold() view returns (uint256)",
  ], ethers.provider);

  // فحوصات أمان قبل النقل
  const owner = await proxy.owner();
  const safeNonce = Number(await safe.nonce());
  const threshold = Number(await safe.getThreshold());
  console.log("\n═══ فحوصات ما قبل النقل ═══");
  console.log("المالك الحالي:", owner);
  console.log("Safe nonce:", safeNonce, safeNonce >= 2 ? "✅ مُختبَر" : "🔴 غير مُختبَر");
  console.log("Safe threshold:", threshold, threshold === 2 ? "✅ 2-of-3" : "⚠️");

  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log("🔴 الناشر ليس المالك — توقّف."); return;
  }
  if (safeNonce < 2) {
    console.log("🔴 الـ Safe لم يُختبَر (nonce<2) — توقّف."); return;
  }

  // النقل
  console.log("\n⏳ transferOwnership →", SAFE);
  const tx = await proxy.transferOwnership(SAFE);
  console.log("TX:", tx.hash);
  console.log("https://basescan.org/tx/" + tx.hash);
  await tx.wait();

  // تأكيد
  const newOwner = await proxy.owner();
  console.log("\n═══ التأكيد ═══");
  console.log("المالك الجديد:", newOwner);
  if (newOwner.toLowerCase() === SAFE.toLowerCase()) {
    console.log("✅ تم نقل الملكية للـ Safe بنجاح!");
    console.log("\n📌 من الآن: كل ترقية/pause/تغيير رسوم تحتاج توقيعين عبر Safe.");
  } else {
    console.log("🔴 المالك لم يتغير كما متوقّع — راجع!");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

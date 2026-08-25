import hre, { ethers, upgrades } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * الرجوع بـBtcEscrowMurabaha إلى implementation سابق مُسجَّل.
 *
 *   IMPL=0x… npx hardhat run scripts/rollback-btc-escrow.ts --network base
 *   (بلا IMPL يعرض السجل ويخرج — وضع القراءة الافتراضي)
 *
 * ⚠️ الرجوع يعيد **المنطق** لا **البيانات**. إن كانت النسخة الهدف تقرأ
 *    `struct Deal` بهيكل مختلف عن الحالي، ستُقرأ الصفقات القائمة خطأً.
 *    لذلك يرفض السكربت أي قيد `rollbackSafe: false` ما لم تُجبره بـFORCE=1.
 */

const REG = path.join(__dirname, "..", "deployments", "btc-escrow.json");

async function main() {
  const reg = JSON.parse(fs.readFileSync(REG, "utf8"));
  const target = process.env.IMPL;

  const current = await upgrades.erc1967.getImplementationAddress(reg.proxy);
  console.log("Proxy            :", reg.proxy);
  console.log("Implementation الآن:", current);
  console.log("\n── نقاط الرجوع المسجَّلة ──");
  for (const h of reg.history) {
    const mark = h.implementation.toLowerCase() === current.toLowerCase() ? "◀ الحالي" : "";
    const safe = h.rollbackSafe ? "✅ آمن" : "⛔ غير آمن";
    console.log(`  ${h.implementation}  ${safe}  ${h.date}  ${h.label} ${mark}`);
    if (!h.rollbackSafe) console.log(`      ${h.why}`);
  }

  if (!target) {
    console.log("\nℹ️ وضع القراءة. للرجوع فعلياً: IMPL=<العنوان> …");
    return;
  }

  const entry = reg.history.find(
    (h: any) => h.implementation.toLowerCase() === target.toLowerCase()
  );
  if (!entry) throw new Error(`⛔ ${target} غير مُسجَّل في ${REG} — لا ترجع لعنوان مجهول`);
  if (entry.implementation.toLowerCase() === current.toLowerCase())
    throw new Error("⛔ هذا هو الـimplementation النشط أصلاً");
  if (!entry.rollbackSafe && process.env.FORCE !== "1")
    throw new Error(`⛔ ${entry.label}: ${entry.why}\n   للتجاوز رغم ذلك: FORCE=1`);

  // العنوان الهدف يجب أن يحمل كوداً فعلياً
  const code = await ethers.provider.getCode(target);
  if (code === "0x") throw new Error(`⛔ لا كود على ${target}`);

  const [signer] = await ethers.getSigners();
  const F = await ethers.getContractFactory("BtcEscrowMurabaha");
  const proxy: any = F.attach(reg.proxy);
  const owner = await proxy.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase())
    throw new Error(`⛔ الموقّع ${signer.address} ليس المالك (${owner})`);

  console.log(`\n⏳ الرجوع إلى ${entry.label}\n   ${target}`);
  const tx = await proxy.upgradeToAndCall(target, "0x");
  console.log("   tx:", tx.hash);
  await tx.wait();

  const after = await upgrades.erc1967.getImplementationAddress(reg.proxy);
  console.log("✅ تمّ الرجوع · Implementation الآن:", after);
  if (after.toLowerCase() !== target.toLowerCase())
    console.warn("⚠️ القراءة قد تكون متأخّرة — تحقّق بـcast implementation");
  void hre;
}

main().catch((e) => { console.error("❌", e.message || e); process.exit(1); });

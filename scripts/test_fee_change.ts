/**
 * اختبار تغيير رسوم البروتوكول من EOA المالك الحالي.
 * - يقرأ القيمة الحالية
 * - يستدعي setProtocolFee بنفس القيمة (لا تأثير ولكن معاملة حقيقية)
 * - يتحقق من النتيجة
 */
import { ethers } from "hardhat";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("\n═══ اختبار تغيير رسوم البروتوكول ═══");
  console.log("الناشر:", deployer.address);

  const proxy = new ethers.Contract(PROXY, [
    "function owner() view returns (address)",
    "function protocolFeeBps() view returns (uint16)",
    "function setProtocolFee(uint16 bps)",
    "event ProtocolFeeChanged(uint16 oldBps, uint16 newBps)",
  ], deployer);

  // 1. تحقق من الملكية
  const owner = await proxy.owner();
  console.log("\n📍 المالك الحالي:", owner);
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log("❌ هذا الحساب ليس المالك — لا يمكن تغيير الرسوم");
    console.log(`   حسابك:    ${deployer.address}`);
    console.log(`   المالك:    ${owner}`);
    return;
  }
  console.log("✅ أنت المالك");

  // 2. القيمة الحالية
  const before = await proxy.protocolFeeBps();
  console.log(`\n💰 protocolFeeBps قبل: ${before} (${Number(before)/100}%)`);

  // 3. نفس القيمة — اختبار بدون تأثير
  const newValue = before;
  console.log(`📝 سيُستخدم نفس القيمة: ${newValue} (اختبار فقط، لا تأثير)`);

  // 4. التنفيذ
  console.log("\n⏳ إرسال المعاملة...");
  const tx = await proxy.setProtocolFee(newValue);
  console.log(`📤 TX: ${tx.hash}`);
  console.log(`🔗 https://basescan.org/tx/${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`✅ مؤكَّد في block ${receipt.blockNumber}`);
  console.log(`⛽ Gas: ${receipt.gasUsed.toString()}`);

  // 5. التحقق
  const after = await proxy.protocolFeeBps();
  console.log(`\n💰 protocolFeeBps بعد: ${after} (${Number(after)/100}%)`);

  if (after === before) {
    console.log("\n✅ نجح الاختبار — الدالة تعمل، القيمة لم تتغير");
  } else {
    console.log("\n⚠️ القيمة تغيّرت! راجع السكريبت");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

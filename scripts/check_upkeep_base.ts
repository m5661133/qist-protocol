import { ethers } from "hardhat";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const ABI = [
  "function checkUpkeep(bytes) view returns (bool upkeepNeeded, bytes performData)",
  "function getPosition(uint256) view returns (tuple(uint256 offerId,address buyer,address saleToken,address collateralToken,address paymentToken,uint256 saleAmount,uint256 collateralAmount,uint256 totalPayable,uint8 totalInstallments,uint8 paidInstallments,uint32 paymentInterval,uint256 nextDueDate,uint8 state))",
];

async function main() {
  const pool = new ethers.Contract(PROXY, ABI, ethers.provider);
  const pos = await pool.getPosition(1);
  const now = Math.floor(Date.now() / 1000);
  const due = Number(pos.nextDueDate);
  const diff = due - now;

  console.log("\n═══════════════════════════════════════");
  console.log("   وضع مركز #1 — BASE MAINNET");
  console.log("═══════════════════════════════════════");
  console.log(`  الأقساط : ${pos.paidInstallments}/${pos.totalInstallments}`);
  console.log(`  الحالة  : ${Number(pos.state) === 0 ? "✅ نشط" : Number(pos.state) === 1 ? "✅ مكتمل" : "🔴 مصفّى"}`);

  if (diff > 0) {
    const mins = Math.floor(diff / 60);
    const secs = diff % 60;
    console.log(`  القسط القادم: بعد ${mins}:${String(secs).padStart(2,'0')} دقيقة`);
  } else {
    console.log(`  ⏰ القسط متأخر منذ ${Math.abs(Math.floor(diff/60))} دقيقة و${Math.abs(diff%60)} ثانية`);
  }

  const [needed] = await pool.checkUpkeep("0x");
  console.log(`  checkUpkeep : ${needed ? "✅ جاهز للتنفيذ" : "⏳ لم يحن الوقت بعد"}`);
  console.log("═══════════════════════════════════════\n");
}
main().catch(console.error);

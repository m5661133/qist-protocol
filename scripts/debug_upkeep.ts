import { ethers } from "hardhat";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const ABI = [
  "function checkUpkeep(bytes calldata) view returns (bool, bytes memory)",
  "function getPosition(uint256) view returns (tuple(uint256 offerId,address buyer,address saleToken,address collateralToken,address paymentToken,uint256 saleAmount,uint256 collateralAmount,uint256 totalPayable,uint8 totalInstallments,uint8 paidInstallments,uint32 paymentInterval,uint256 nextDueDate,uint8 state))",
  "function isLiquidatable(uint256) view returns (bool, string)",
  "function GRACE_PERIOD() view returns (uint256)",
  "function nextPositionId() view returns (uint256)",
];

async function main() {
  const pool = new ethers.Contract(PROXY, ABI, ethers.provider);
  const grace = await pool.GRACE_PERIOD();
  const nextP = await pool.nextPositionId();
  const now = Math.floor(Date.now() / 1000);

  console.log(`\nGRACE_PERIOD: ${grace}s = ${Number(grace)/60} min`);
  console.log(`عدد المراكز: ${Number(nextP) - 1}`);

  for (let i = 1; i < Number(nextP); i++) {
    const pos = await pool.getPosition(i);
    const due = Number(pos.nextDueDate);
    const overdue = now - due;
    const gracePassed = overdue > Number(grace);

    console.log(`\nمركز #${i}:`);
    console.log(`  الحالة   : ${Number(pos.state) === 0 ? "نشط" : Number(pos.state) === 1 ? "مكتمل" : "مصفّى"}`);
    console.log(`  الأقساط  : ${pos.paidInstallments}/${pos.totalInstallments}`);
    console.log(`  nextDueDate: ${new Date(due*1000).toISOString()}`);
    console.log(`  تأخر منذ : ${overdue}s (${(overdue/60).toFixed(1)} دقيقة)`);
    console.log(`  GRACE_PERIOD مضت؟ : ${gracePassed ? "✅ نعم" : "❌ لا"}`);

    try {
      const [liq, reason] = await pool.isLiquidatable(i);
      console.log(`  isLiquidatable: ${liq} | ${reason}`);
    } catch(e: any) { console.log(`  isLiquidatable: خطأ - ${e.message.slice(0,60)}`); }
  }
}
main().catch(console.error);

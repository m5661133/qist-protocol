import { ethers } from "hardhat";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const ABI = [
  "function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory performData)",
  "function getPosition(uint256) view returns (tuple(uint256 offerId,address buyer,address saleToken,address collateralToken,address paymentToken,uint256 saleAmount,uint256 collateralAmount,uint256 totalPayable,uint8 totalInstallments,uint8 paidInstallments,uint32 paymentInterval,uint256 nextDueDate,uint8 state))",
  "function nextPositionId() view returns (uint256)",
  "function healthFactor(uint256) view returns (uint256)",
  "function GRACE_PERIOD() view returns (uint256)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider("https://base-rpc.publicnode.com");
  const pool = new ethers.Contract(PROXY, ABI, provider);
  
  const now = Math.floor(Date.now() / 1000);
  const stateMap = ["نشط 🟢","مكتمل ✅","مصفّى 🔴"];

  console.log("\n═══════════════════════════════════════════");
  
  const grace = await pool.GRACE_PERIOD();
  console.log(`GRACE_PERIOD على السلسلة: ${grace}s = ${Number(grace)/60} دقيقة`);
  console.log(`الوقت الحالي: ${new Date(now*1000).toLocaleString('ar-SA')}`);
  
  const [needed] = await pool.checkUpkeep.staticCall("0x");
  console.log(`checkUpkeep: ${needed ? "✅ يحتاج معالجة" : "❌ لا شيء الآن"}`);
  
  const nextId = await pool.nextPositionId();
  console.log(`إجمالي المراكز: ${Number(nextId)-1}\n`);

  for (let i = 1; i < Number(nextId); i++) {
    try {
      const pos = await pool.getPosition(i);
      const state = Number(pos.state);
      const nextDue = Number(pos.nextDueDate);
      const isLate = now > nextDue;
      const lateBy = now - nextDue;
      
      const icon = stateMap[state];
      console.log(`── مركز #${i} ──── ${icon}`);
      console.log(`  الأقساط: ${pos.paidInstallments}/${pos.totalInstallments}`);
      
      if (state === 0) { // نشط
        console.log(`  الموعد القادم: ${new Date(nextDue*1000).toISOString()}`);
        if (isLate) {
          const mins = Math.floor(lateBy/60);
          const secs = lateBy % 60;
          const overGrace = lateBy > Number(grace);
          console.log(`  ⚠️  متأخر بـ: ${mins}د ${secs}ث`);
          console.log(`  تجاوز GRACE(${grace}s): ${overGrace ? "✅ يجب التصفية — لكن checkUpkeep=false !!!" : `❌ باقي ${Number(grace)-lateBy}ث`}`);
          if (overGrace) console.log(`  🔴 BUG محتمل: متجاوز GRACE لكن checkUpkeep=false`);
        } else {
          const rem = nextDue - now;
          console.log(`  ⏳ باقي: ${Math.floor(rem/3600)}س ${Math.floor((rem%3600)/60)}د`);
        }
        try {
          const hf = await pool.healthFactor(i);
          console.log(`  عامل الصحة: ${(Number(hf)/100).toFixed(1)}%`);
        } catch {}
        console.log(`  الضمان: ${ethers.formatEther(pos.collateralAmount)} ETH`);
        console.log(`  الفترة: ${Number(pos.paymentInterval)/60} دقيقة`);
      }
      console.log();
    } catch (e: any) {
      if (!e.message?.includes("out-of-bounds")) {
        console.log(`مركز #${i}: ${e.shortMessage || e.message}\n`);
      }
    }
  }
  console.log("═══════════════════════════════════════════");
}
main().catch(console.error);

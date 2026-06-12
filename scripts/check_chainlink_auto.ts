import { ethers } from "hardhat";
const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const ABI = [
  "function checkUpkeep(bytes calldata) external view returns (bool, bytes memory)",
  "function GRACE_PERIOD() view returns (uint256)",
  "function nextPositionId() view returns (uint256)",
  "function getPosition(uint256) view returns (tuple(uint256,address,address,address,address,uint256,uint256,uint256,uint8,uint8,uint32,uint256,uint8))",
];
async function main() {
  const pool = new ethers.Contract(PROXY, ABI, ethers.provider);
  const grace = await pool.GRACE_PERIOD();
  const nextP = await pool.nextPositionId();
  const [needed, data] = await pool.checkUpkeep("0x");
  const now = Math.floor(Date.now()/1000);

  console.log("══ تشخيص Chainlink Automation ══");
  console.log("GRACE_PERIOD :", grace.toString()+"s =", Number(grace)/60, "دقيقة");
  console.log("checkUpkeep  :", needed ? "✅ يحتاج تنفيذ" : "❌ لا يوجد ما يُعالَج");
  if (needed) {
    const id = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], data)[0];
    console.log("المركز المستهدف:", id.toString());
  }
  
  console.log("\n── حالة المراكز ──");
  for (let i = 1; i < Number(nextP); i++) {
    const p = await pool.getPosition(i);
    const state = ["✅ نشط","✔️ مكتمل","🔴 مصفّى"][Number(p[12])];
    const due = Number(p[11]);
    const overdue = now - due;
    console.log(`مركز #${i}: ${state} | ${p[9]}/${p[8]} أقساط | تأخر: ${overdue > 0 ? overdue+"s" : "لم يحن"}`);
  }
}
main().catch(console.error);

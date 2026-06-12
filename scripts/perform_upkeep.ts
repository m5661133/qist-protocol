import { ethers } from "hardhat";

const PROXY = "0x027C5f1aFBD9FCef650E135794E3AB865180bC8A";

const ABI = [
  "function checkUpkeep(bytes) view returns (bool upkeepNeeded, bytes performData)",
  "function performUpkeep(bytes performData)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const pool = new ethers.Contract(PROXY, ABI, signer);

  console.log("\n🔍 فحص checkUpkeep...");
  const [needed, data] = await pool.checkUpkeep("0x");
  console.log(`   upkeepNeeded: ${needed}`);

  if (!needed) {
    console.log("   ℹ️  لا يوجد شيء للتنفيذ الآن");
    return;
  }

  console.log("⚡ تنفيذ performUpkeep...");
  const tx = await pool.performUpkeep(data);
  console.log(`   TX: ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`   ✅ تم! Block: ${rc.blockNumber}`);

  // طباعة الأحداث
  for (const log of rc.logs) {
    try {
      const iface = new ethers.Interface([
        "event InstallmentPaid(uint256 indexed positionId, uint256 amount, uint256 remaining)",
        "event PositionLiquidated(uint256 indexed positionId, address indexed buyer, uint256 collateralSold)",
        "event PositionCompleted(uint256 indexed positionId)",
      ]);
      const parsed = iface.parseLog(log);
      if (parsed) console.log(`   📢 ${parsed.name}:`, parsed.args);
    } catch {}
  }
}

main().catch(console.error);

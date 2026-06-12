import { ethers } from "hardhat";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const ABI = [
  "function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory performData)",
  "function performUpkeep(bytes calldata performData) external",
  "function getPosition(uint256) view returns (tuple(uint256 offerId,address buyer,address saleToken,address collateralToken,address paymentToken,uint256 saleAmount,uint256 collateralAmount,uint256 totalPayable,uint8 totalInstallments,uint8 paidInstallments,uint32 paymentInterval,uint256 nextDueDate,uint8 state))",
];
const EVENTS = new ethers.Interface([
  "event InstallmentPaid(uint256 indexed positionId, uint8 installment, uint256 amount)",
  "event PositionLiquidated(uint256 indexed positionId, uint256 sellerCollateral, uint256 buyerRefund, string reason)",
  "event PositionCompleted(uint256 indexed positionId, uint256 collateralReturned)",
]);

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("\n── Base Mainnet ──────────────────────────────");
  console.log("المنفّذ:", signer.address);
  
  const pool = new ethers.Contract(PROXY, ABI, signer);

  // 1) checkUpkeep أولاً — نأخذ performData الصحيحة
  console.log("\n1️⃣  checkUpkeep...");
  const [needed, perfData] = await pool.checkUpkeep.staticCall("0x");
  console.log(`  upkeepNeeded : ${needed}`);
  console.log(`  performData  : ${perfData}`);

  if (!needed) {
    console.log("\n⚠️  لا توجد مراكز تحتاج معالجة الآن");
    return;
  }

  const positionId = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], perfData)[0];
  console.log(`  ← المركز #${positionId} يحتاج معالجة`);

  // 2) حالة المركز قبل
  const pos = await pool.getPosition(positionId);
  const stateMap = ["نشط","مكتمل","مصفّى"];
  console.log(`\n  حالة المركز #${positionId} (قبل): ${stateMap[Number(pos.state)]}`);
  console.log(`  الضمان المتبقي: ${ethers.formatEther(pos.collateralAmount)} ETH`);

  // 3) performUpkeep مع performData الصحيحة
  console.log("\n2️⃣  performUpkeep...");
  const tx = await pool.performUpkeep(perfData, { gasLimit: 500_000 });
  console.log(`  TX: ${tx.hash}`);
  console.log(`  https://basescan.org/tx/${tx.hash}`);
  
  const rc = await tx.wait();
  console.log(`  ✅ Block: ${rc.blockNumber}, Gas: ${rc.gasUsed}`);

  // 4) تحليل الأحداث
  let liquidated = false;
  for (const log of rc.logs) {
    try {
      const parsed = EVENTS.parseLog(log);
      if (!parsed) continue;
      console.log(`\n📢 ${parsed.name}:`);
      if (parsed.name === "PositionLiquidated") {
        liquidated = true;
        console.log(`  مركز #${parsed.args[0]}`);
        console.log(`  حصة البائع  : ${ethers.formatEther(parsed.args[1])} ETH`);
        console.log(`  استرداد المشتري: ${ethers.formatEther(parsed.args[2])} ETH`);
        console.log(`  السبب        : ${parsed.args[3]}`);
      } else if (parsed.name === "InstallmentPaid") {
        console.log(`  مركز #${parsed.args[0]}, قسط #${parsed.args[1]}`);
        console.log(`  المبلغ: ${(Number(parsed.args[2])/1e6).toFixed(4)} USDC`);
      } else if (parsed.name === "PositionCompleted") {
        console.log(`  مركز #${parsed.args[0]}, ضمان مُرتجع: ${ethers.formatEther(parsed.args[1])} ETH`);
      }
    } catch {}
  }

  if (liquidated) {
    console.log("\n🔴 تمت التصفية بنجاح على Base Mainnet!");
  } else {
    console.log("\n✅ تمت معالجة القسط بنجاح على Base Mainnet!");
  }
}
main().catch(console.error);

/**
 * deploy_build18 — ينشر implementation Build 18 فقط (الترقية عبر Safe لأنه المالك).
 *   npx hardhat run scripts/deploy_build18.ts --network base
 *
 * Build 18 = M-01 (تخطي auto-pay غير القابل للتحصيل) + M-03 (totalPendingETH
 * + guardian + حماية emergencyWithdraw). storage مُلحق بالنهاية — تحقّق OZ رسمي ✅.
 *
 * يفعل:
 *  1. لقطة قبل (تُقارن يدوياً بعد تنفيذ الـ Safe للترقية)
 *  2. نشر implementation جديد
 *  3. طباعة calldata جاهزة للـ Safe Transaction Builder (ترقية + setGuardian)
 */
import { ethers } from "hardhat";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const SAFE  = "0x64D738021BAe4cb9a7fd82529C2F94f61d404064";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("🚀 نشر implementation Build 18 — الناشر:", deployer.address);
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log("رصيد الناشر:", ethers.formatEther(bal), "ETH");

  // 1) لقطة قبل
  const c = new ethers.Contract(PROXY, [
    "function owner() view returns (address)",
    "function nextOfferId() view returns (uint256)",
    "function nextPositionId() view returns (uint256)",
    "function protocolFeeBps() view returns (uint16)",
    "function activePositionsCount() view returns (uint256)",
    "function sequencerUptimeFeed() view returns (address)",
  ], ethers.provider);
  console.log("\n📸 لقطة قبل الترقية:");
  console.log("  owner:", await c.owner());
  console.log("  nextOfferId:", (await c.nextOfferId()).toString(),
              "· nextPositionId:", (await c.nextPositionId()).toString());
  console.log("  protocolFeeBps:", (await c.protocolFeeBps()).toString(),
              "· active:", (await c.activePositionsCount()).toString(),
              "· seqFeed:", await c.sequencerUptimeFeed());

  // 2) نشر implementation
  console.log("\n⏳ نشر MurabahaV6 (Build 18)...");
  const impl = await (await ethers.getContractFactory("MurabahaV6")).deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("✅ Implementation Build 18:", implAddr);

  // 3) calldata للـ Safe (دفعة واحدة: ترقية ثم تعيين الحارس)
  const iface = new ethers.Interface([
    "function upgradeToAndCall(address newImplementation, bytes data) payable",
    "function setGuardian(address g)",
  ]);
  console.log("\n═══ Safe Transaction Builder — دفعة من معاملتين على:", PROXY, "═══");
  console.log("\nTX1 — upgradeToAndCall(Build18, 0x):");
  console.log(iface.encodeFunctionData("upgradeToAndCall", [implAddr, "0x"]));
  console.log("\nTX2 — setGuardian(Safe):");
  console.log(iface.encodeFunctionData("setGuardian", [SAFE]));
  console.log("\nETH value = 0 في الاثنتين · وقّع بمحفظتين ثم Execute.");
}

main().catch((e) => { console.error(e); process.exit(1); });

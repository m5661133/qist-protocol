/**
 * deploy_build19 — ينشر implementation Build 19 فقط (الترقية عبر Safe).
 *   npx hardhat run scripts/deploy_build19.ts --network base
 *
 * Build 19 = D-056: تقييد emergencyWithdraw — يحظر ETH/USDC/cbBTC/أي مدعوم،
 * يسترجع الرموز الغريبة فقط → protocolTreasury. لا متغيّر تخزين جديد (منطق فقط).
 */
import { ethers } from "hardhat";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("🚀 نشر implementation Build 19 — الناشر:", deployer.address);
  console.log("رصيد الناشر:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // لقطة قبل
  const c = new ethers.Contract(PROXY, [
    "function owner() view returns (address)",
    "function nextOfferId() view returns (uint256)",
    "function nextPositionId() view returns (uint256)",
    "function protocolFeeBps() view returns (uint16)",
    "function guardian() view returns (address)",
  ], ethers.provider);
  console.log("\n📸 قبل: owner", await c.owner(),
              "| nextOffer", (await c.nextOfferId()).toString(),
              "| nextPos", (await c.nextPositionId()).toString(),
              "| fee", (await c.protocolFeeBps()).toString(),
              "| guardian", await c.guardian());

  console.log("\n⏳ نشر MurabahaV6 (Build 19)...");
  const impl = await (await ethers.getContractFactory("MurabahaV6")).deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("✅ Implementation Build 19:", implAddr);

  const iface = new ethers.Interface(["function upgradeToAndCall(address,bytes) payable"]);
  console.log("\n═══ Safe Transaction Builder — معاملة واحدة على:", PROXY, "═══");
  console.log("Data (Hex):");
  console.log(iface.encodeFunctionData("upgradeToAndCall", [implAddr, "0x"]));
  console.log("\nETH value = 0 · وقّع بمحفظتين ثم Execute.");
}

main().catch((e) => { console.error(e); process.exit(1); });

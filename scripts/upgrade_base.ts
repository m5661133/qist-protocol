import { ethers } from "hardhat";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("\n🔄 ترقية MurabahaV6 على Base...");
  console.log("الناشر:", deployer.address);

  // نشر Implementation جديد
  const Factory = await ethers.getContractFactory("MurabahaV6");
  const newImpl = await Factory.deploy();
  await newImpl.waitForDeployment();
  const newImplAddr = await newImpl.getAddress();
  console.log("✅ Implementation جديد:", newImplAddr);

  // استدعاء upgradeToAndCall على الـ proxy
  const proxy = new ethers.Contract(PROXY, [
    "function upgradeToAndCall(address newImplementation, bytes calldata data) payable external",
    "function GRACE_PERIOD() view returns (uint256)",
  ], deployer);

  const tx = await proxy.upgradeToAndCall(newImplAddr, "0x");
  console.log("TX:", tx.hash);
  await tx.wait();

  // تحقق
  const grace = await proxy.GRACE_PERIOD();
  console.log(`\n✅ تمت الترقية!`);
  console.log(`GRACE_PERIOD الجديد: ${grace}s = ${Number(grace)/60} دقيقة`);
  console.log(`Proxy: ${PROXY}`);
  console.log(`Implementation: ${newImplAddr}`);
}
main().catch(console.error);

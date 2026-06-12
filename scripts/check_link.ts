import { ethers } from "hardhat";

// Sepolia LINK token
const LINK = "0x779877A7B0D9E8603169DdbD7836e478b4624789";
const OWNER = "0xef6F0C01C1f61a798923Baf57eb515f45d68c2e4";

async function main() {
  const link = new ethers.Contract(LINK, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
  const bal = await link.balanceOf(OWNER);
  console.log(`\nرصيد LINK: ${ethers.formatEther(bal)} LINK`);
  if (bal < ethers.parseEther("3")) {
    console.log("⚠️  تحتاج على الأقل 3 LINK");
    console.log("   احصل عليها من: https://faucets.chain.link/sepolia");
  } else {
    console.log("✅ رصيد كافي");
  }
}
main().catch(console.error);

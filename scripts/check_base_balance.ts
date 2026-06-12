import { ethers } from "hardhat";

const OWNER  = "0xef6F0C01C1f61a798923Baf57eb515f45d68c2e4";
const USDC   = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CBBTC  = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const ERC20  = ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"];

async function main() {
  const provider = ethers.provider;
  const eth   = await provider.getBalance(OWNER);
  
  let usdcBal = 0n, cbbtcBal = 0n;
  try { usdcBal  = await new ethers.Contract(USDC,  ERC20, provider).balanceOf(OWNER); } catch {}
  try { cbbtcBal = await new ethers.Contract(CBBTC, ERC20, provider).balanceOf(OWNER); } catch {}

  console.log("\n═══════════════════════════════════════");
  console.log("   رصيد المالك على BASE MAINNET");
  console.log("═══════════════════════════════════════");
  console.log(`  ETH   : ${ethers.formatEther(eth)} ETH`);
  console.log(`  USDC  : ${(Number(usdcBal)/1e6).toFixed(2)} USDC`);
  console.log(`  cbBTC : ${(Number(cbbtcBal)/1e8).toFixed(8)} cbBTC`);
  
  const block = await provider.getBlockNumber();
  console.log(`\n  ✅ Base متصل — Block: ${block}`);
  
  if (eth < ethers.parseEther("0.005")) {
    console.log("\n  ⚠️  رصيد ETH غير كافٍ للنشر!");
    console.log("     تحتاج على الأقل 0.005 ETH على Base");
    console.log("     أرسل ETH من Coinbase أو Bridge من Ethereum");
  } else {
    console.log("  ✅ رصيد كافٍ للنشر");
  }
  console.log("═══════════════════════════════════════\n");
}
main().catch(console.error);

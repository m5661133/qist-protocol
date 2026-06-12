import { ethers } from "hardhat";

const PROXY  = "0x027C5f1aFBD9FCef650E135794E3AB865180bC8A";
const USDC   = "0x5fEEA8Ca3B4d342082Fff03D24934375c5e594D9";
const WBTC   = "0x0C0114d6A15BBa02a7ef89894462d52eE5F283A7";

const OWNER  = "0xef6F0C01C1f61a798923Baf57eb515f45d68c2e4";
const BROKER = "0xbF435581067E4FcB9e1001619087F4e9a846d8be";
// المشتري في الصفقة المصفّاة (من الـ UI: 0x5e23...F117)
const BUYER_POS5 = "0x5e23398A6E0C5fde65F65c6CBb1B22f6a38F117".replace("38F117","38F117");

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const ABI = [
  "function pendingETH(address) view returns (uint256)",
  "function brokerTreasury() view returns (address)",
  "function protocolTreasury() view returns (address)",
];

async function main() {
  const provider = ethers.provider;
  const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);
  const wbtc = new ethers.Contract(WBTC, ERC20_ABI, provider);
  const pool = new ethers.Contract(PROXY, ABI, provider);

  const fmt6  = (n: bigint) => (Number(n)/1e6).toFixed(4);
  const fmt18 = (n: bigint) => parseFloat(ethers.formatEther(n)).toFixed(6);

  const wallets = [
    { label: "👑 المالك  (Owner) ", addr: OWNER  },
    { label: "🏢 التطبيق (Broker)", addr: BROKER },
  ];

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("       الأرصدة الكاملة");
  console.log("═══════════════════════════════════════════════════════\n");

  for (const w of wallets) {
    const ethBal  = await provider.getBalance(w.addr);
    const usdcBal = await usdc.balanceOf(w.addr);
    const wbtcBal = await wbtc.balanceOf(w.addr);
    const pendETH = await pool.pendingETH(w.addr);

    console.log(`${w.label}`);
    console.log(`  ETH (محفظة)    : ${fmt18(ethBal)} ETH`);
    console.log(`  USDC (محفظة)   : ${fmt6(usdcBal)} USDC`);
    console.log(`  WBTC (محفظة)   : ${wbtcBal} satoshi`);
    console.log(`  ETH (في العقد) : ${fmt18(pendETH)} ETH  ${pendETH > 0n ? "← قابل للسحب ✅" : ""}`);
    console.log();
  }

  // رصيد العقد الكلي
  const contractETH  = await provider.getBalance(PROXY);
  const contractUSDC = await usdc.balanceOf(PROXY);

  console.log("═══════════════════════════════════════════════════════");
  console.log("       رصيد العقد الإجمالي");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  ETH  : ${fmt18(contractETH)} ETH`);
  console.log(`  USDC : ${fmt6(contractUSDC)} USDC`);
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch(console.error);

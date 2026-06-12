import { ethers } from "hardhat";

const PROXY    = "0x027C5f1aFBD9FCef650E135794E3AB865180bC8A";
const USDC     = "0x5fEEA8Ca3B4d342082Fff03D24934375c5e594D9";
const WBTC     = "0x0C0114d6A15BBa02a7ef89894462d52eE5F283A7";

const OWNER    = "0xef6F0C01C1f61a798923Baf57eb515f45d68c2e4";
const BROKER   = "0xbF435581067E4FcB9e1001619087F4e9a846d8be";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

const CONTRACT_ABI = [
  "function brokerTreasury() view returns (address)",
  "function protocolTreasury() view returns (address)",
  "function protocolFeeBps() view returns (uint256)",
  "function brokerageFeeBps() view returns (uint256)",
];

async function main() {
  const provider = ethers.provider;
  const usdc  = new ethers.Contract(USDC, ERC20_ABI, provider);
  const wbtc  = new ethers.Contract(WBTC, ERC20_ABI, provider);
  const pool  = new ethers.Contract(PROXY, CONTRACT_ABI, provider);

  const fmt6  = (n: bigint) => (Number(n) / 1e6).toFixed(2);
  const fmt8  = (n: bigint) => (Number(n) / 1e8).toFixed(6);
  const fmt18 = (n: bigint) => parseFloat(ethers.formatEther(n)).toFixed(6);

  const wallets = [
    { label: "👑 المالك  (Owner)", addr: OWNER },
    { label: "🏢 التطبيق (Broker)", addr: BROKER },
  ];

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("          أرصدة المحافظ — Sepolia Testnet");
  console.log("═══════════════════════════════════════════════════════\n");

  for (const w of wallets) {
    const eth   = await provider.getBalance(w.addr);
    const usdcB = await usdc.balanceOf(w.addr);
    const wbtcB = await wbtc.balanceOf(w.addr);

    console.log(`${w.label}`);
    console.log(`  Address : ${w.addr}`);
    console.log(`  ETH     : ${fmt18(eth)} ETH`);
    console.log(`  USDC    : ${fmt6(usdcB)} USDC`);
    console.log(`  WBTC    : ${fmt8(wbtcB)} WBTC`);
    console.log();
  }

  // Contract settings
  const brokerT   = await pool.brokerTreasury();
  const protocolT = await pool.protocolTreasury();
  const feeBps    = await pool.protocolFeeBps();
  const brokBps   = await pool.brokerageFeeBps();

  console.log("═══════════════════════════════════════════════════════");
  console.log("          إعدادات العقد الحالية");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  protocolTreasury  : ${protocolT}`);
  console.log(`  brokerTreasury    : ${brokerT}`);
  console.log(`  protocolFeeBps    : ${feeBps} (${Number(feeBps)/100}%)`);
  console.log(`  brokerageFeeBps   : ${brokBps} (${Number(brokBps)/100}% per side)`);
  console.log();

  if (brokerT.toLowerCase() === BROKER.toLowerCase()) {
    console.log("  ✅ brokerTreasury = التطبيق — صحيح");
  } else {
    console.log(`  ⚠️  brokerTreasury ≠ التطبيق! القيمة الحالية: ${brokerT}`);
  }
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch(console.error);

import { ethers } from "hardhat";

const PROXY  = "0x027C5f1aFBD9FCef650E135794E3AB865180bC8A";
const USDC   = "0x5fEEA8Ca3B4d342082Fff03D24934375c5e594D9";
const WBTC   = "0x0C0114d6A15BBa02a7ef89894462d52eE5F283A7";
const OWNER  = "0xef6F0C01C1f61a798923Baf57eb515f45d68c2e4";
const BROKER = "0xbF435581067E4FcB9e1001619087F4e9a846d8be";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

const ABI = [
  "function brokerTreasury() view returns (address)",
  "function protocolTreasury() view returns (address)",
  "function creditBalance(address account, address token) view returns (uint256)",
  "function pendingWithdrawals(address) view returns (uint256)",
  "function protocolFeeBps() view returns (uint256)",
  "function brokerageFeeBps() view returns (uint256)",
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

  console.log("\n═══════════════════════════════════════════════════");
  console.log("       أرصدة المحافظ + الأرصدة الداخلية في العقد");
  console.log("═══════════════════════════════════════════════════\n");

  for (const w of wallets) {
    const ethBal  = await provider.getBalance(w.addr);
    const usdcBal = await usdc.balanceOf(w.addr);
    const wbtcBal = await wbtc.balanceOf(w.addr);

    // أرصدة داخلية في العقد
    let pendETH  = 0n;
    let creditUSDC = 0n;
    let creditWBTC = 0n;

    try { pendETH    = await pool.pendingWithdrawals(w.addr); } catch {}
    try { creditUSDC = await pool.creditBalance(w.addr, USDC); } catch {}
    try { creditWBTC = await pool.creditBalance(w.addr, WBTC); } catch {}

    console.log(`${w.label}`);
    console.log(`  ──── محفظة خارجية ────`);
    console.log(`  ETH  : ${fmt18(ethBal)} ETH`);
    console.log(`  USDC : ${fmt6(usdcBal)} USDC`);
    console.log(`  WBTC : ${wbtcBal} satoshi`);
    console.log(`  ──── داخل العقد (pending) ────`);
    if (pendETH  > 0n) console.log(`  ETH  : ${fmt18(pendETH)} ETH  ← قابل للسحب`);
    if (creditUSDC > 0n) console.log(`  USDC : ${fmt6(creditUSDC)} USDC  ← قابل للسحب`);
    if (creditWBTC > 0n) console.log(`  WBTC : ${creditWBTC} satoshi  ← قابل للسحب`);
    if (pendETH === 0n && creditUSDC === 0n && creditWBTC === 0n) {
      console.log(`  (لا يوجد شيء معلّق)`);
    }
    console.log();
  }

  // رصيد USDC و ETH في العقد نفسه
  const contractETH  = await provider.getBalance(PROXY);
  const contractUSDC = await usdc.balanceOf(PROXY);
  const contractWBTC = await wbtc.balanceOf(PROXY);

  console.log("═══════════════════════════════════════════════════");
  console.log("       رصيد العقد الإجمالي");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  ETH  : ${fmt18(contractETH)} ETH`);
  console.log(`  USDC : ${fmt6(contractUSDC)} USDC`);
  console.log(`  WBTC : ${contractWBTC} satoshi`);
  console.log("═══════════════════════════════════════════════════\n");
}

main().catch(console.error);

import { ethers } from "hardhat";

const TX = "0x4654d32b5dbc22f9253eeefb1f0caff821516e0f74cf939b41172c31a1648dc5";

const IFACE = new ethers.Interface([
  "event InstallmentPaid(uint256 indexed positionId, uint256 amount, uint256 remaining)",
  "event PositionLiquidated(uint256 indexed positionId, address indexed buyer, uint256 collateralSold)",
  "event PositionCompleted(uint256 indexed positionId)",
  "event BrokerageCollected(uint256 indexed positionId, address brokerTreasury, uint256 brokerAmount, address protocolTreasury, uint256 protocolAmount)",
  "event Credited(address indexed to, address indexed token, uint256 amount)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

async function main() {
  const rc = await ethers.provider.getTransactionReceipt(TX);
  console.log(`\nجميع Events في TX:\n`);
  let found = 0;
  for (const log of rc!.logs) {
    try {
      const parsed = IFACE.parseLog(log);
      if (parsed) {
        found++;
        console.log(`📢 ${parsed.name}`);
        const obj = parsed.args.toObject ? parsed.args.toObject() : {};
        for (const [k, v] of Object.entries(obj)) {
          let display = String(v);
          if (typeof v === 'bigint') {
            display = `${v}  [USDC: ${(Number(v)/1e6).toFixed(4)}]  [ETH: ${ethers.formatEther(v)}]`;
          }
          console.log(`   ${k}: ${display}`);
        }
        console.log();
      }
    } catch {}
  }
  if (found === 0) console.log("لا توجد أحداث معروفة في الـ TX");
}
main().catch(console.error);

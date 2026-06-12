import { ethers } from "hardhat";

const TX = "0x4654d32b5dbc22f9253eeefb1f0caff821516e0f74cf939b41172c31a1648dc5";

const IFACE = new ethers.Interface([
  "event InstallmentPaid(uint256 indexed positionId, uint8 installment, uint256 amount)",
  "event PositionCompleted(uint256 indexed positionId, uint256 collateralReturned)",
  "event PositionLiquidated(uint256 indexed positionId, uint256 sellerCollateral, uint256 buyerRefund, string reason)",
  "event BrokerageCollected(uint256 indexed offerId, address saleToken, uint256 sellerFee, uint256 buyerFee, uint256 protocolFee, address brokerTreasury, address protocolTreasury)",
  "event Credited(address indexed account, uint256 amount)",
]);

async function main() {
  const rc = await ethers.provider.getTransactionReceipt(TX);
  console.log("\n📋 Events في TX:\n");
  
  for (const log of rc!.logs) {
    try {
      const parsed = IFACE.parseLog(log);
      if (parsed) {
        console.log(`📢 ${parsed.name}`);
        for (let i = 0; i < parsed.fragment.inputs.length; i++) {
          const name = parsed.fragment.inputs[i].name;
          const val  = parsed.args[i];
          let display = String(val);
          if (typeof val === 'bigint') {
            display = `${val}  [= ${(Number(val)/1e6).toFixed(4)} USDC]`;
          }
          console.log(`   ${name}: ${display}`);
        }
        console.log();
      }
    } catch(e) {}
  }
  
  // أيضاً طباعة topic
  for (const log of rc!.logs) {
    const t = log.topics[0];
    const checks = [
      "InstallmentPaid(uint256,uint8,uint256)",
      "PositionCompleted(uint256,uint256)",
      "PositionLiquidated(uint256,uint256,uint256,string)",
    ];
    for (const sig of checks) {
      if (ethers.id(sig) === t) {
        console.log(`✅ Topic match: ${sig}`);
      }
    }
  }
}
main().catch(console.error);

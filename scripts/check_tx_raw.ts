import { ethers } from "hardhat";

const TX = "0x4654d32b5dbc22f9253eeefb1f0caff821516e0f74cf939b41172c31a1648dc5";

async function main() {
  const rc = await ethers.provider.getTransactionReceipt(TX);
  console.log(`\nعدد الـ logs: ${rc!.logs.length}`);
  console.log(`Status: ${rc!.status} (1=success, 0=fail)`);
  console.log(`Gas used: ${rc!.gasUsed}`);
  
  for (let i = 0; i < rc!.logs.length; i++) {
    const log = rc!.logs[i];
    console.log(`\nLog[${i}]:`);
    console.log(`  Address: ${log.address}`);
    console.log(`  Topics[0]: ${log.topics[0]}`);
    console.log(`  Data: ${log.data.slice(0, 66)}...`);
  }
}
main().catch(console.error);

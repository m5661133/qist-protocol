import { ethers } from "hardhat";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";

const IFACE = new ethers.Interface([
  "event Purchased(uint256 indexed positionId, uint256 indexed offerId, address indexed buyer, uint256 saleAmount, uint256 collateralAmount, uint256 totalPayable, uint8 selectedInstallments)",
  "event InstallmentPaid(uint256 indexed positionId, uint8 installment, uint256 amount)",
  "event PositionCompleted(uint256 indexed positionId, uint256 collateralReturned)",
  "event EarlyRepaidCash(uint256 indexed positionId, uint256 amountPayment)",
  "event EarlyRepaidCollateral(uint256 indexed positionId, uint256 sellerCollateral, uint256 buyerRefund)",
  "event PositionLiquidated(uint256 indexed positionId, uint256 sellerCollateral, uint256 buyerRefund, string reason)",
  "event PartialPurchaseCreated(uint256 indexed positionId, uint256 indexed offerId, uint256 purchasedAmount, uint256 remainingInOffer)",
]);

async function main() {
  const provider = new ethers.JsonRpcProvider("https://base-rpc.publicnode.com");
  
  const latest = await provider.getBlockNumber();
  // نبحث من آخر 900,000 بلوك (~5 أيام)
  const CHUNK = 49_000;
  const START = latest - 900_000;
  
  console.log(`بلوك حالي: ${latest}`);
  console.log(`نبحث من ${START} إلى ${latest} (${Math.ceil(900_000/CHUNK)} chunk)`);
  
  const pos12Hex = ethers.zeroPadValue(ethers.toBeHex(12), 32);
  const allLogs: any[] = [];
  
  for (let from = START; from < latest; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, latest);
    process.stdout.write(`\r  ⏳ ${from}..${to}`);
    try {
      const logs = await provider.getLogs({
        address: PROXY,
        fromBlock: from,
        toBlock: to,
      });
      // فلتر على positionId=12 (topic[1])
      const filtered = logs.filter(l => l.topics[1] === pos12Hex);
      allLogs.push(...filtered);
    } catch (e: any) {
      process.stdout.write(` ⚠️ خطأ: ${e.shortMessage}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  
  console.log(`\n\nوجدت ${allLogs.length} حدث للمركز #12\n`);
  
  if (allLogs.length === 0) {
    console.log("❌ لا أحداث — هل المركز #12 قديم أكثر من 5 أيام؟");
    // نفحص الـ state مباشرة
    const ABI2 = [
      "function getPosition(uint256) view returns (tuple(uint256 offerId,address buyer,address saleToken,address collateralToken,address paymentToken,uint256 saleAmount,uint256 collateralAmount,uint256 totalPayable,uint8 totalInstallments,uint8 paidInstallments,uint32 paymentInterval,uint256 nextDueDate,uint8 state))",
    ];
    const pool = new ethers.Contract(PROXY, ABI2, provider);
    const pos = await pool.getPosition(12);
    console.log("\nبيانات المركز #12 من العقد:");
    console.log(`  buyer: ${pos.buyer}`);
    console.log(`  state: ${["نشط","مكتمل","مصفّى"][Number(pos.state)]}`);
    console.log(`  paidInstallments: ${pos.paidInstallments}/${pos.totalInstallments}`);
    console.log(`  nextDueDate: ${new Date(Number(pos.nextDueDate)*1000).toISOString()}`);
    console.log(`  collateralAmount: ${ethers.formatEther(pos.collateralAmount)} ETH`);
    return;
  }
  
  // ترتيب وطباعة
  allLogs.sort((a,b) => a.blockNumber - b.blockNumber);
  
  for (const log of allLogs) {
    try {
      const parsed = IFACE.parseLog(log);
      if (!parsed) continue;
      const block = await provider.getBlock(log.blockNumber);
      const time = new Date(Number(block!.timestamp)*1000).toISOString();
      const tx = await provider.getTransaction(log.transactionHash);
      
      console.log(`📢 ${parsed.name}`);
      console.log(`   🕐 ${time}  بلوك #${log.blockNumber}`);
      console.log(`   👤 من: ${tx?.from}`);
      console.log(`   🔗 https://basescan.org/tx/${log.transactionHash}`);
      
      if (parsed.name === "Purchased") {
        console.log(`   أقساط: ${parsed.args[6]}, saleAmount: ${(Number(parsed.args[3])/1e6).toFixed(2)} USDC`);
        console.log(`   ضمان: ${ethers.formatEther(parsed.args[4])} ETH`);
      } else if (parsed.name === "InstallmentPaid") {
        console.log(`   قسط #${parsed.args[1]}: ${(Number(parsed.args[2])/1e6).toFixed(4)} USDC`);
      } else if (parsed.name === "PositionCompleted") {
        console.log(`   ✅ ضمان مُرتجع: ${ethers.formatEther(parsed.args[1])} ETH`);
      } else if (parsed.name === "PositionLiquidated") {
        console.log(`   🔴 حصة البائع: ${ethers.formatEther(parsed.args[1])} ETH`);
        console.log(`   استرداد المشتري: ${ethers.formatEther(parsed.args[2])} ETH`);
        console.log(`   السبب: ${parsed.args[3]}`);
      } else if (parsed.name === "EarlyRepaidCollateral") {
        console.log(`   سداد مبكر بالضمان — بائع: ${ethers.formatEther(parsed.args[1])} ETH`);
      }
      console.log();
    } catch {}
  }
}
main().catch(console.error);

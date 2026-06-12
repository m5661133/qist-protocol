import { ethers } from "hardhat";

const PROXY    = "0x027C5f1aFBD9FCef650E135794E3AB865180bC8A";
const TX_HASH  = "0xb2721c688ae60ca728e8476e9d23433678c97fa57244ae7cf03c3b26ec3ce113";
const ABI = [
  "function getPosition(uint256) view returns (tuple(uint256 offerId,address buyer,address saleToken,address collateralToken,address paymentToken,uint256 saleAmount,uint256 collateralAmount,uint256 totalPayable,uint8 totalInstallments,uint8 paidInstallments,uint32 paymentInterval,uint256 nextDueDate,uint8 state))",
  "event EarlyRepaidCollateral(uint256 indexed positionId, uint256 sellerCollateral, uint256 buyerRefund)",
  "event PositionCompleted(uint256 indexed positionId, uint256 collateralReturned)",
  "event Credited(address indexed account, uint256 amount)",
];
const STATES = ["🟢 نشط", "✅ مكتمل", "🔴 مُصفَّى"];

async function main() {
  const [signer] = await ethers.getSigners();
  const provider  = signer.provider!;
  const contract  = new ethers.Contract(PROXY, ABI, provider);

  const pos = await contract.getPosition(2);
  console.log("═══════════════════════════════");
  console.log("  مركز #2 الآن");
  console.log("═══════════════════════════════");
  console.log("  الحالة:       ", STATES[Number(pos.state)]);
  console.log("  أقساط مدفوعة:", `${pos.paidInstallments}/${pos.totalInstallments}`);
  console.log("  ضمان متبقي:   ", ethers.formatEther(pos.collateralAmount), "ETH");
  console.log("  إجمالي الديون:", (Number(pos.totalPayable)/1e6).toFixed(2), "USDC");

  const receipt = await provider.getTransactionReceipt(TX_HASH);
  if (!receipt) { console.log("TX غير موجودة"); return; }

  console.log("\n═══════════════════════════════");
  console.log("  تفاصيل المعاملة");
  console.log("═══════════════════════════════");
  console.log("  Status:", receipt.status === 1 ? "✅ ناجحة" : "❌ فاشلة");
  console.log("  Gas:   ", receipt.gasUsed.toString(), "units");

  const iface = new ethers.Interface(ABI);
  for (const log of receipt.logs) {
    try {
      const p = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!p) continue;
      if (p.name === "EarlyRepaidCollateral") {
        const seller = p.args.sellerCollateral as bigint;
        const buyer  = p.args.buyerRefund     as bigint;
        const total  = seller + buyer;
        console.log("\n  📋 EarlyRepaidCollateral:");
        console.log("    ضمان ذهب للبائع:", ethers.formatEther(seller), "ETH",
          `($${(Number(seller)/1e18*2100).toFixed(2)} تقريباً)`);
        console.log("    رُدَّ للمشتري:  ", ethers.formatEther(buyer),  "ETH",
          buyer > 0n ? `($${(Number(buyer)/1e18*2100).toFixed(2)} تقريباً)` : "(لا فائض)");
        if (total > 0n) {
          const pct = Number(seller * 10000n / total) / 100;
          console.log("    نسبة للبائع:  ", pct.toFixed(1) + "%");
          console.log("    نسبة للمشتري:", (100 - pct).toFixed(1) + "%");
        }
      }
      if (p.name === "PositionCompleted") {
        console.log("\n  ✅ PositionCompleted:",
          ethers.formatEther(p.args.collateralReturned as bigint), "ETH عاد");
      }
      if (p.name === "Credited") {
        console.log(`  💳 Credited → ${p.args.account}: ${ethers.formatEther(p.args.amount as bigint)} ETH`);
      }
    } catch {}
  }
}
main().catch(console.error);

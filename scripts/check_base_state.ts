import { ethers } from "hardhat";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const ABI = [
  "function nextOfferId() view returns (uint256)",
  "function nextPositionId() view returns (uint256)",
  "function getOffer(uint256) view returns (tuple(address seller,address saleToken,address collateralToken,address paymentToken,uint256 totalAmount,uint256 saleAmount,uint256 minPurchaseAmount,uint16 profitBps,uint8 minInstallments,uint8 maxInstallments,uint32 paymentInterval,uint16 collateralRatioBps,uint8 state))",
  "function getPosition(uint256) view returns (tuple(uint256 offerId,address buyer,address saleToken,address collateralToken,address paymentToken,uint256 saleAmount,uint256 collateralAmount,uint256 totalPayable,uint8 totalInstallments,uint8 paidInstallments,uint32 paymentInterval,uint256 nextDueDate,uint8 state))",
  "function healthFactor(uint256) view returns (uint256)",
];

async function main() {
  const pool = new ethers.Contract(PROXY, ABI, ethers.provider);
  const nextO = await pool.nextOfferId();
  const nextP = await pool.nextPositionId();

  console.log("\n═══════════════════════════════════════════");
  console.log("   حالة العقد — BASE MAINNET");
  console.log("═══════════════════════════════════════════");
  console.log(`  عدد العروض   : ${Number(nextO)}`);
  console.log(`  عدد المراكز  : ${Number(nextP)}`);

  for (let i = 1; i < Number(nextO); i++) {
    const o = await pool.getOffer(i);
    console.log(`\n  عرض #${i}:`);
    console.log(`    البائع : ${o.seller}`);
    console.log(`    الكمية : ${ethers.formatEther(o.saleAmount)} ETH`);
    console.log(`    الحالة : ${Number(o.state) === 0 ? "✅ نشط" : "🔒 مغلق"}`);
  }

  for (let i = 1; i < Number(nextP); i++) {
    const p = await pool.getPosition(i);
    const states = ["✅ نشط", "✅ مكتمل", "🔴 مصفّى"];
    console.log(`\n  مركز #${i}:`);
    console.log(`    المشتري  : ${p.buyer}`);
    console.log(`    الكمية   : ${ethers.formatEther(p.saleAmount)} ETH`);
    console.log(`    الأقساط  : ${p.paidInstallments}/${p.totalInstallments}`);
    console.log(`    الحالة   : ${states[Number(p.state)]}`);
    const hf = await pool.healthFactor(i);
    console.log(`    HF       : ${(Number(hf)/100).toFixed(1)}%`);
  }
  console.log("\n═══════════════════════════════════════════\n");
}
main().catch(console.error);

import { ethers } from "hardhat";

const PROXY  = "0x027C5f1aFBD9FCef650E135794E3AB865180bC8A";
const POS_ID = 3;
const ABI = [
  "function getPosition(uint256) view returns (tuple(uint256 offerId,address buyer,address saleToken,address collateralToken,address paymentToken,uint256 saleAmount,uint256 collateralAmount,uint256 totalPayable,uint8 totalInstallments,uint8 paidInstallments,uint32 paymentInterval,uint256 nextDueDate,uint8 state))",
  "function healthFactor(uint256) view returns (uint256)",
  "function checkUpkeep(bytes) view returns (bool, bytes)",
  "function performUpkeep(bytes) external",
  "event InstallmentPaid(uint256 indexed positionId, uint8 installment, uint256 amount)",
  "event PositionCompleted(uint256 indexed positionId, uint256 collateralReturned)",
  "event PositionLiquidated(uint256 indexed positionId, uint256 sellerCollateral, uint256 buyerRefund, string reason)",
];
const STATES = ["🟢 نشط", "✅ مكتمل", "🔴 مُصفَّى"];

async function main() {
  const [signer] = await ethers.getSigners();
  const provider  = signer.provider!;
  const contract  = new ethers.Contract(PROXY, ABI, provider);
  const cSigned   = new ethers.Contract(PROXY, ABI, signer);

  console.log(`👁️  مراقبة مركز #${POS_ID} — تحديث كل 10 ث`);
  console.log("🤖 سيُشغَّل performUpkeep تلقائياً\n");

  for (let i = 0; i < 80; i++) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const [pos, hf, upkeep] = await Promise.all([
        contract.getPosition(POS_ID),
        contract.healthFactor(POS_ID),
        contract.checkUpkeep("0x"),
      ]);
      const due   = Number(pos.nextDueDate);
      const diff  = due - now;
      const state = Number(pos.state);
      const paid  = Number(pos.paidInstallments);
      const total = Number(pos.totalInstallments);
      const [upkeepNeeded, upkeepData] = upkeep;

      const timeStr = diff > 0
        ? `⏳ ${Math.floor(diff/60)}:${String(diff%60).padStart(2,"0")} للاستحقاق`
        : `⏰ مستحق منذ ${Math.abs(diff)} ث`;

      console.log(`[${new Date().toLocaleTimeString()}] ${STATES[state]}  HF=${(Number(hf)/100).toFixed(1)}%  ${timeStr}  أقساط:${paid}/${total}  Upkeep:${upkeepNeeded?"⚡":"💤"}`);

      if (upkeepNeeded && state === 0) {
        console.log("  🚀 تشغيل performUpkeep...");
        try {
          const tx = await cSigned.performUpkeep(upkeepData);
          const receipt = await tx.wait();
          console.log("  ✅ TX:", tx.hash);

          // تفسير الأحداث
          const iface = new ethers.Interface(ABI);
          for (const log of receipt.logs) {
            try {
              const p = iface.parseLog({ topics:[...log.topics], data:log.data });
              if (!p) continue;
              if (p.name === "InstallmentPaid")
                console.log(`  💳 قسط #${p.args.installment} خُصم: ${(Number(p.args.amount)/1e6).toFixed(2)} USDC`);
              if (p.name === "PositionCompleted")
                console.log(`  🎉 مكتمل! ضمان عاد: ${ethers.formatEther(p.args.collateralReturned as bigint)} ETH`);
              if (p.name === "PositionLiquidated")
                console.log(`  🔴 تصفية! للبائع:${ethers.formatEther(p.args.sellerCollateral as bigint)} ETH  للمشتري:${ethers.formatEther(p.args.buyerRefund as bigint)} ETH`);
            } catch {}
          }
        } catch(e:any) {
          console.log("  ⏳ revert (Grace Period لم تنتهِ):", e.shortMessage?.slice(0,50) || "");
        }
      }

      console.log("─".repeat(70));
      if (state !== 0) {
        console.log(`\n🏁 انتهت الصفقة: ${STATES[state]}`);
        break;
      }
    } catch(e:any) { console.log("خطأ:", e.message?.slice(0,60)); }

    await new Promise(r => setTimeout(r, 10000));
  }
}
main().catch(console.error);

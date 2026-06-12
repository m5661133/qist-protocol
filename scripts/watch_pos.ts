import { ethers } from "hardhat";

const PROXY  = "0x027C5f1aFBD9FCef650E135794E3AB865180bC8A";
const POS_ID = 1;
const ABI = [
  "function getPosition(uint256) view returns (tuple(uint256 offerId,address buyer,address saleToken,address collateralToken,address paymentToken,uint256 saleAmount,uint256 collateralAmount,uint256 totalPayable,uint8 totalInstallments,uint8 paidInstallments,uint32 paymentInterval,uint256 nextDueDate,uint8 state))",
  "function healthFactor(uint256) view returns (uint256)",
  "function isLiquidatable(uint256) view returns (bool, string)",
  "function checkUpkeep(bytes) view returns (bool, bytes)",
  "function performUpkeep(bytes) external",
];
const STATES = ["🟢 نشط", "✅ مكتمل", "🔴 مُصفَّى"];
const fmt6  = (n: bigint) => (Number(n)/1e6).toFixed(2);
const fmt18 = (n: bigint) => (Number(n)/1e18).toFixed(4);

async function main() {
  const [signer] = await ethers.getSigners();
  const provider = signer.provider!;
  const contract = new ethers.Contract(PROXY, ABI, provider);
  const contractSigned = new ethers.Contract(PROXY, ABI, signer);

  console.log("👁️  مراقبة مركز #" + POS_ID + " — تحديث كل 10 ثوانٍ");
  console.log("🤖 سيُنفَّذ performUpkeep تلقائياً عند الحاجة\n");

  let triggered = false;

  for (let i = 0; i < 60; i++) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const [pos, hf, liqCheck, upkeep] = await Promise.all([
        contract.getPosition(POS_ID),
        contract.healthFactor(POS_ID),
        contract.isLiquidatable(POS_ID),
        contract.checkUpkeep("0x"),
      ]);

      const due   = Number(pos.nextDueDate);
      const diff  = due - now;
      const state = Number(pos.state);
      const hfNum = Number(hf);
      const [liqOk, liqReason] = liqCheck;
      const [upkeepNeeded, upkeepData] = upkeep;

      const timeStr = diff > 0
        ? `⏳ ${Math.floor(diff/60)}:${String(diff%60).padStart(2,"0")} للاستحقاق`
        : `⏰ مستحق منذ ${Math.abs(diff)} ث`;

      console.log(`[${new Date().toLocaleTimeString()}]  ${STATES[state]}  HF=${(hfNum/100).toFixed(1)}%  ${timeStr}`);
      console.log(`  Paid: ${pos.paidInstallments}/${pos.totalInstallments}  |  قابل تصفية: ${liqOk ? "✅ "+liqReason : "❌"}  |  Upkeep: ${upkeepNeeded ? "⚡" : "💤"}`);

      if (upkeepNeeded && state === 0) {
        console.log("  🚀 تشغيل performUpkeep...");
        try {
          const tx = await contractSigned.performUpkeep(upkeepData);
          const receipt = await tx.wait();
          console.log("  ✅ TX:", tx.hash);
          triggered = true;
        } catch (e: any) {
          console.log("  ❌ فشل:", e.shortMessage || e.message);
        }
      }

      console.log("─".repeat(60));

      if (state !== 0) {
        console.log("\n🏁 انتهت الصفقة:", STATES[state]);
        if (state === 2) {
          console.log("  ضمان المشتري: " + fmt18(pos.collateralAmount) + " ETH (صُفِّي)");
        }
        break;
      }
    } catch (e: any) {
      console.log("خطأ:", e.message?.slice(0,80));
    }

    await new Promise(r => setTimeout(r, 10000));
  }
}
main().catch(console.error);

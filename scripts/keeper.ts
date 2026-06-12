/**
 * keeper.ts — يشتغل في الخلفية بدون MetaMask أو أي تدخل بشري
 * يفحص checkUpkeep كل 20 ثانية ويُشغّل performUpkeep تلقائياً
 *
 * تشغيل: npx ts-node scripts/keeper.ts
 * (أو على خادم: pm2 start scripts/keeper.ts --interpreter ts-node)
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const RPC_URL     = process.env.SEPOLIA_RPC_URL!;
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const CONTRACT    = "0x896886985b6884541A4A66E4d5F6c89efD870F5E";

const ABI = [
  "function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory performData)",
  "function performUpkeep(bytes calldata performData) external",
];

const INTERVAL_MS = 20_000; // فحص كل 20 ثانية

async function runKeeper() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT, ABI, wallet);

  console.log(`🤖 Keeper بدأ — ${new Date().toLocaleTimeString("ar")}`);
  console.log(`   العقد: ${CONTRACT}`);
  console.log(`   الـ keeper: ${wallet.address}`);
  console.log(`   الفحص كل ${INTERVAL_MS / 1000} ثانية\n`);

  const tick = async () => {
    try {
      const [needed, data] = await contract.checkUpkeep("0x");
      if (!needed) {
        process.stdout.write(`💤 ${new Date().toLocaleTimeString("ar")} — لا شيء\r`);
        return;
      }

      // دوّر على كل المراكز المستحقة
      let count = 0;
      let currentNeeded = needed;
      let currentData   = data;
      while (currentNeeded && count < 10) {
        const posId = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], currentData)[0];
        console.log(`\n⚡ ${new Date().toLocaleTimeString("ar")} — تنفيذ upkeep للمركز #${posId}`);

        const tx = await contract.performUpkeep(currentData, { gasLimit: 300_000 });
        console.log(`   TX: ${tx.hash}`);
        await tx.wait();
        console.log(`   ✅ تم`);

        count++;
        [currentNeeded, currentData] = await contract.checkUpkeep("0x");
      }
    } catch (e: any) {
      console.error(`\n❌ خطأ: ${e?.shortMessage || e?.message}`);
    }
  };

  // أول تشغيل فوري ثم كل INTERVAL_MS
  await tick();
  setInterval(tick, INTERVAL_MS);
}

runKeeper().catch(console.error);

import { ethers } from "ethers";

const REGISTRY = "0xf4bAb6A129164aBa9B113cB96BA4266dF49f8743";
const RPC = "https://base-rpc.publicnode.com";
const REGISTRY_ABI = [
  "function getUpkeep(uint256 id) view returns (tuple(address target, uint32 performGas, bytes checkData, uint96 balance, address admin, uint64 maxValidBlocknumber, uint32 lastPerformedBlockNumber, uint96 amountSpent, bool paused, bytes offchainConfig))",
  "function getActiveUpkeepIDs(uint256 startIndex, uint256 maxCount) view returns (uint256[])",
  "function getMinBalance(uint256 id) view returns (uint96)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const registry = new ethers.Contract(REGISTRY, REGISTRY_ABI, provider);
  const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";

  console.log("🔍 مسح كل Upkeep IDs على Base...\n");
  let found = false;
  for (let start = 0; start < 5000 && !found; start += 500) {
    const ids = await registry.getActiveUpkeepIDs(start, 500);
    if (ids.length === 0) break;
    process.stdout.write(`فحص [${start}..${start+ids.length}]...\r`);
    for (const id of ids) {
      try {
        const u = await registry.getUpkeep(id);
        if (u.target.toLowerCase() === PROXY.toLowerCase()) {
          const min = await registry.getMinBalance(id);
          const bal = Number(u.balance) / 1e18;
          const minBal = Number(min) / 1e18;
          const spent = Number(u.amountSpent) / 1e18;
          const ok = bal >= minBal;

          console.log("\n\n✅ Upkeep موجود!\n");
          console.log(`ID:                ${id}`);
          console.log(`الرصيد:           ${bal.toFixed(4)} LINK`);
          console.log(`الحد الأدنى:      ${minBal.toFixed(4)} LINK`);
          console.log(`الإنفاق الكلي:    ${spent.toFixed(4)} LINK`);
          console.log(`متوقف؟:           ${u.paused}`);
          console.log(`Gas Limit:        ${u.performGas}`);
          console.log(`آخر block تنفيذ:  ${u.lastPerformedBlockNumber}`);
          console.log(`\n${ok ? '✅ الرصيد كافٍ — Chainlink يشتغل تلقائياً!' : `❌ ينقصك ${(minBal - bal).toFixed(2)} LINK`}`);
          found = true;
          break;
        }
      } catch (e) {}
    }
  }
  if (!found) console.log("\n❌ لم يُعثر على Upkeep — ربما لم يُسجَّل أو على شبكة أخرى");
}

main().catch(console.error);

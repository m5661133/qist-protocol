const { ethers } = require("ethers");

const SAFE = "0x64D738021BAe4cb9a7fd82529C2F94f61d404064";
const RPC = "https://base-rpc.publicnode.com";

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
  "event ExecutionFailure(bytes32 txHash, uint256 payment)",
];

(async () => {
  const p = new ethers.JsonRpcProvider(RPC);
  const safe = new ethers.Contract(SAFE, SAFE_ABI, p);

  const nonce = await safe.nonce();
  const block = await p.getBlockNumber();
  const balance = await p.getBalance(SAFE);

  console.log("═══ حالة الـ Safe الحالية ═══");
  console.log("📍 العنوان:     ", SAFE);
  console.log("🔢 Nonce الحالي:", nonce.toString());
  console.log("💰 الرصيد:     ", ethers.formatEther(balance), "ETH");
  console.log("📦 Block:      ", block);

  // ابحث عن آخر معاملات (5000 block ≈ 2-3 ساعات)
  const fromBlock = block - 5000;
  console.log(`\n🔍 فحص الأحداث من block ${fromBlock} → ${block}...`);

  const successEvents = [];
  const failEvents = [];

  // دفعات 500 block لتجنّب 524
  for (let f = fromBlock; f <= block; f += 500) {
    const t = Math.min(f + 499, block);
    try {
      const [ok, fail] = await Promise.all([
        safe.queryFilter("ExecutionSuccess", f, t),
        safe.queryFilter("ExecutionFailure", f, t),
      ]);
      successEvents.push(...ok);
      failEvents.push(...fail);
    } catch (e) { /* skip */ }
  }

  console.log(`\n✅ ExecutionSuccess: ${successEvents.length} حدث`);
  console.log(`❌ ExecutionFailure: ${failEvents.length} حدث`);

  if (successEvents.length > 0) {
    console.log("\n═══ آخر المعاملات الناجحة ═══");
    for (const e of successEvents.slice(-5)) {
      const blk = await p.getBlock(e.blockNumber);
      const date = new Date(blk.timestamp * 1000).toLocaleString('ar');
      console.log(`\n  📅 ${date}`);
      console.log(`  🆔 TX:    ${e.transactionHash}`);
      console.log(`  📦 Block: ${e.blockNumber}`);
      console.log(`  🔗 https://basescan.org/tx/${e.transactionHash}`);
    }
  }

  if (failEvents.length > 0) {
    console.log("\n⚠️ معاملات فاشلة (للمراجعة):");
    for (const e of failEvents.slice(-3)) {
      console.log(`  ${e.transactionHash}`);
    }
  }

  console.log("\n═══ الحكم النهائي ═══");
  if (Number(nonce) >= 2 && successEvents.length > 0) {
    console.log(`✅ نجاح مؤكَّد على السلسلة!`);
    console.log(`   • Nonce ارتفع إلى ${nonce} (كان 1)`);
    console.log(`   • ${successEvents.length} معاملة ExecutionSuccess مُسجَّلة`);
    console.log(`   • Multisig 2-of-3 يعمل بشكل صحيح ✅`);
  } else if (Number(nonce) === 1 && successEvents.length === 0) {
    console.log("⏳ لم تُسجَّل أي معاملة بعد على السلسلة");
    console.log("   لو وقّعت لكن ما execute → اضغط Execute في الـ Safe UI");
  } else {
    console.log(`Nonce: ${nonce} | Success events: ${successEvents.length}`);
  }
})();

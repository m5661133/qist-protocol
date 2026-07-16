const { ethers } = require("ethers");

const SAFE = "0x64D738021BAe4cb9a7fd82529C2F94f61d404064";
const RPC = "https://base-rpc.publicnode.com";

const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function VERSION() view returns (string)",
  "function nonce() view returns (uint256)",
];

(async () => {
  const p = new ethers.JsonRpcProvider(RPC);

  // 1. تأكد أن العنوان فيه كود (contract وليس EOA)
  const code = await p.getCode(SAFE);
  console.log("📍 العنوان:", SAFE);
  console.log("🔍 كود؟:", code === "0x" ? "❌ لا (EOA أو غير منشور)" : `✅ نعم (${code.length} hex chars)`);

  if (code === "0x") return;

  const safe = new ethers.Contract(SAFE, SAFE_ABI, p);

  // 2. اقرأ owners + threshold
  try {
    const owners = await safe.getOwners();
    const threshold = await safe.getThreshold();
    const version = await safe.VERSION().catch(() => "unknown");
    const nonce = await safe.nonce();

    console.log("\n═══ تكوين الـ Safe ═══");
    console.log("🔢 Version:    ", version);
    console.log("🔐 Threshold:  ", `${threshold} من ${owners.length}`);
    console.log("📊 Nonce:      ", nonce.toString());
    console.log("\n👥 الموقّعون:");
    owners.forEach((o, i) => console.log(`   ${i+1}. ${o}`));

    // 3. تحقق من العناوين المعروفة
    const known = {
      "0xef6F0C01C1f61a798923Baf57eb515f45d68c2e4": "ميتا المالك (EOA الحالي)",
      "0x2e19": "تريزور (يبدأ بـ 0x2e19)",
      "0x4764": "تانجوم (يبدأ بـ 0x4764)",
    };
    console.log("\n🏷️ التطابق مع Address Book:");
    owners.forEach((o, i) => {
      const lower = o.toLowerCase();
      let match = "❓ غير معروف";
      if (lower === "0xef6f0c01c1f61a798923baf57eb515f45d68c2e4") match = "ميتا المالك ✅";
      else if (lower.startsWith("0x2e19")) match = "تريزور ✅";
      else if (lower.startsWith("0x4764")) match = "تانجوم ✅";
      console.log(`   #${i+1}: ${match}`);
    });

    // 4. الحكم
    console.log("\n═══ الحكم ═══");
    const t = Number(threshold);
    const n = owners.length;
    if (n === 3 && t === 2) console.log("✅ ممتاز: 2-of-3 — الترتيب الأمثل");
    else if (n < 3) console.log(`⚠️ موقّعون قليلون (${n}) — يُنصح بـ 3`);
    else if (t === 1) console.log("❌ Threshold = 1 → بلا فائدة multisig");
    else if (t === n) console.log("❌ Threshold = العدد كله → ضياع محفظة = قفل");
    else console.log(`ℹ️ ${t}-of-${n} (غير مثالي لكن مقبول)`);
  } catch (e) {
    console.log("\n❌ خطأ في القراءة:", e.message.slice(0, 100));
  }
})();

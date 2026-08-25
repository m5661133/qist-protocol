/**
 * deploy_build21 — ينشر implementation Build 21 فقط (الترقية عبر Safe).
 *   npx hardhat run scripts/deploy_build21.ts --network base
 *
 * Build 21 = Build 20 (سقف الإطلاق المحروس: setLaunchCaps + فحص _buy)
 *          + إصلاح KRAIT-001: emergencyWithdraw يفحص العضوية الدائمة في tokenList
 *            (_everRegistered) بدل tokenConfigs[token].active المتغيّر → يحمي كل رمز مدعوم.
 * لا متغيّر تخزين جديد سوى maxPositionValueUSDC/maxActivePositions (مُلحَقان في النهاية — آمن UUPS).
 */
import { ethers } from "hardhat";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("🚀 نشر implementation Build 21 — الناشر:", deployer.address);
  console.log("رصيد الناشر:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // لقطة قبل
  const c = new ethers.Contract(PROXY, [
    "function owner() view returns (address)",
    "function nextOfferId() view returns (uint256)",
    "function nextPositionId() view returns (uint256)",
    "function protocolFeeBps() view returns (uint16)",
    "function guardian() view returns (address)",
  ], ethers.provider);
  console.log("\n📸 قبل: owner", await c.owner(),
              "| nextOffer", (await c.nextOfferId()).toString(),
              "| nextPos", (await c.nextPositionId()).toString(),
              "| fee", (await c.protocolFeeBps()).toString(),
              "| guardian", await c.guardian());

  console.log("\n⏳ نشر MurabahaV6 (Build 21)...");
  const impl = await (await ethers.getContractFactory("MurabahaV6")).deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("✅ Implementation Build 21:", implAddr);

  // ═══ معاملة Safe رقم 1: الترقية ═══
  const up = new ethers.Interface(["function upgradeToAndCall(address,bytes) payable"]);
  console.log("\n═══ Safe TX #1 — الترقية · على العنوان:", PROXY, "═══");
  console.log("Data (Hex):");
  console.log(up.encodeFunctionData("upgradeToAndCall", [implAddr, "0x"]));

  // ═══ معاملة Safe رقم 2: ضبط سقف الإطلاق $10k (على نفس العنوان PROXY) ═══
  const caps = new ethers.Interface(["function setLaunchCaps(uint256,uint256)"]);
  console.log("\n═══ Safe TX #2 — ضبط السقف · على العنوان:", PROXY, "═══");
  console.log("خيار (أ) اختبار — مركز واحد ≤ $10k:");
  console.log("  setLaunchCaps(10000000000, 1) →");
  console.log("  " + caps.encodeFunctionData("setLaunchCaps", [10_000_000000n, 1n]));
  console.log("خيار (ب) إطلاق محروس — إجمالي ≤ $10k (5 مراكز × $2k):");
  console.log("  setLaunchCaps(2000000000, 5) →");
  console.log("  " + caps.encodeFunctionData("setLaunchCaps", [2_000_000000n, 5n]));

  console.log("\nETH value = 0 لكل معاملة · وقّع بمحفظتين ثم Execute · نفّذ #1 ثم #2.");
  console.log("⚠️ اضبط السقف (#2) قبل أي بيع/شراء حقيقي.");
  console.log("📝 بعد النجاح: حدّث Implementation address في ../CLAUDE.md");
}

main().catch((e) => { console.error(e); process.exit(1); });

import { ethers, upgrades } from "hardhat";

/**
 * ترقية MurabahaV6 — نفس عنوان الـ Proxy، كود جديد
 * ✅ يستدعي initializeV2() لترحيل tokenConfigs تلقائياً
 * ✅ Chainlink Automation يبقى يعمل بدون إعادة تسجيل
 */

const PROXY_ADDRESS = "0x638F31d338F1114978036411Ed7578c2ACa3119b";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("الناشر:", deployer.address);
  console.log("الرصيد:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");
  console.log("Proxy:", PROXY_ADDRESS);

  const MurabahaV6New = await ethers.getContractFactory("MurabahaV6");

  console.log("\nجاري التحقق من توافق التخزين (storage layout)...");
  const upgraded = await upgrades.upgradeProxy(PROXY_ADDRESS, MurabahaV6New, {
    kind: "uups",
    unsafeAllow: ["constructor"],
    // استدعاء initializeV2() بعد رفع الكود الجديد مباشرة
    call: { fn: "initializeV2", args: [] },
  });
  await upgraded.waitForDeployment();

  const newImpl = await upgrades.erc1967.getImplementationAddress(PROXY_ADDRESS);
  console.log("\n✅ تمت الترقية بنجاح!");
  console.log("Proxy (نفس العنوان):", PROXY_ADDRESS);
  console.log("Implementation الجديد:", newImpl);

  // التحقق من أن tokenConfigs اشتغل
  const proxy = await ethers.getContractAt("MurabahaV6", PROXY_ADDRESS);
  const tokens = await proxy.getSupportedTokens();
  console.log("\n✅ التوكنات المسجّلة:", tokens);
  console.log("   ETH  (0x000...):", tokens.includes(ethers.ZeroAddress) ? "✓" : "✗");

  console.log("\n⭐ Chainlink Automation: يبقى يعمل — لا تحتاج إعادة تسجيل");
  console.log("🔗 الـ UI جاهز على: https://hlal5-ui.vercel.app");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

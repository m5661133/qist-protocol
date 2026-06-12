import { ethers, upgrades, network } from "hardhat";

/**
 * نشر MurabahaV6 على Base Mainnet
 *
 * التوكنات الحقيقية على Base:
 *   USDC  : 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  (Circle native)
 *   cbBTC : 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf  (Coinbase BTC — بديل WBTC)
 *
 * Chainlink Feeds على Base:
 *   ETH/USD: 0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70
 *   BTC/USD: 0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F
 */

// ── عناوين Base Mainnet ──────────────────────────────────────────
const CHAINLINK_ETH_USD = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const CHAINLINK_BTC_USD = "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F";
const USDC_BASE         = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // 6 decimals
const CBBTC_BASE        = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"; // 8 decimals (مثل WBTC)
// ────────────────────────────────────────────────────────────────

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("\n════════════════════════════════════════════");
  console.log("  نشر MurabahaV6 على BASE MAINNET");
  console.log("════════════════════════════════════════════");
  console.log("الناشر :", deployer.address);
  console.log("الشبكة :", network.name);
  console.log("الرصيد :", ethers.formatEther(balance), "ETH");

  if (balance < ethers.parseEther("0.005")) {
    console.error("\n❌ الرصيد غير كافٍ! تحتاج على الأقل 0.005 ETH على Base");
    process.exit(1);
  }

  if (network.name !== "base") {
    console.error("\n❌ هذا السكريبت مخصص لـ Base فقط!");
    console.error("   استخدم: npx hardhat run scripts/deploy-base.ts --network base");
    process.exit(1);
  }

  console.log("\n📋 التوكنات:");
  console.log("  USDC  :", USDC_BASE);
  console.log("  cbBTC :", CBBTC_BASE);
  console.log("  ETH/USD feed:", CHAINLINK_ETH_USD);
  console.log("  BTC/USD feed:", CHAINLINK_BTC_USD);

  console.log("\n🚀 نشر MurabahaV6 كـ UUPS Proxy...");
  const Murabaha = await ethers.getContractFactory("MurabahaV6");

  const proxy = await upgrades.deployProxy(Murabaha, [
    USDC_BASE,
    CBBTC_BASE,
    CHAINLINK_ETH_USD,
    CHAINLINK_BTC_USD,
    deployer.address, // brokerTreasury ← غيّره لـ Gnosis Safe لاحقاً
    deployer.address  // protocolTreasury
  ], {
    kind: "uups",
    initializer: "initialize",
    unsafeAllow: ["constructor"] as const,
  });

  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  const implAddr  = await upgrades.erc1967.getImplementationAddress(proxyAddr);

  console.log("\n✅ تم النشر بنجاح!");
  console.log("══════════════════════════════════════════════════════");
  console.log("  Proxy (العنوان الثابت) :", proxyAddr);
  console.log("  Implementation         :", implAddr);
  console.log("  USDC                   :", USDC_BASE);
  console.log("  cbBTC                  :", CBBTC_BASE);
  console.log("  ETH/USD feed           :", CHAINLINK_ETH_USD);
  console.log("  BTC/USD feed           :", CHAINLINK_BTC_USD);
  console.log("══════════════════════════════════════════════════════");

  console.log("\n📋 POST-DEPLOY CHECKLIST:");
  console.log("[ ] 1. تحقق على Basescan:", `https://basescan.org/address/${proxyAddr}`);
  console.log("[ ] 2. تحقق من الكود:");
  console.log(`       npx hardhat verify --network base ${implAddr}`);
  console.log("[ ] 3. حدّث configV6.js:");
  console.log(`       CONTRACT_V6   = "${proxyAddr}"`);
  console.log(`       USDC_ADDRESS  = "${USDC_BASE}"`);
  console.log(`       WBTC_ADDRESS  = "${CBBTC_BASE}"  ← cbBTC`);
  console.log("[ ] 4. npm run build && vercel --prod --yes");
  console.log("[ ] 5. Chainlink Automation على Base:");
  console.log("       https://automation.chain.link/base");
  console.log(`       → Register → Custom Logic → ${proxyAddr}`);
  console.log("[ ] 6. حدّث project_state.md");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

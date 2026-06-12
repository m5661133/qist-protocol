import { ethers, upgrades, network } from "hardhat";

/**
 * نشر MurabahaV6 كـ UUPS Upgradeable Proxy على Sepolia
 *
 * فائدة الـ Proxy:
 *  - عنوان واحد ثابت للأبد — Chainlink Automation لا يُعاد تسجيله عند كل تحديث
 *  - المستخدمون لا يُعيدون الـ approve — نفس العنوان دائماً
 *  - الترقية: upgrades.upgradeProxy(proxyAddress, MurabahaV6V2)
 *
 * عناوين Chainlink الرسمية على Sepolia:
 *   ETH/USD: 0x694AA1769357215DE4FAC081bf1f309aDC325306
 *   BTC/USD: 0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43
 */

const CHAINLINK_ETH_USD = "0x694AA1769357215DE4FAC081bf1f309aDC325306";
const CHAINLINK_BTC_USD = "0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("الناشر:", deployer.address);
  console.log("الشبكة:", network.name);
  console.log("الرصيد:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // توكنات اختبار على testnet — على mainnet استبدلها بالعناوين الحقيقية
  let usdcAddr: string;
  let wbtcAddr: string;

  // تلميح: لتوفير الـ ETH، مرر عناوين Mock مسبقة النشر:
  //   USDC_ADDR=0x... WBTC_ADDR=0x... npx hardhat run scripts/deploy-v6.ts --network sepolia
  const ENV_USDC = process.env.USDC_ADDR;
  const ENV_WBTC = process.env.WBTC_ADDR;

  if (network.name === "sepolia" || network.name === "hardhat" || network.name === "localhost") {
    if (ENV_USDC && ENV_WBTC) {
      usdcAddr = ENV_USDC;
      wbtcAddr = ENV_WBTC;
      console.log("⏩ استخدام Mock tokens مسبقة النشر:");
      console.log("  MockUSDC:", usdcAddr);
      console.log("  MockWBTC:", wbtcAddr);
    } else {
      console.log("نشر توكنات اختبار (MockUSDC / MockWBTC)...");
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdc = await MockUSDC.deploy();
      await usdc.waitForDeployment();
      usdcAddr = await usdc.getAddress();
      console.log("  MockUSDC:", usdcAddr);

      const MockWBTC = await ethers.getContractFactory("MockWBTC");
      const wbtc = await MockWBTC.deploy();
      await wbtc.waitForDeployment();
      wbtcAddr = await wbtc.getAddress();
      console.log("  MockWBTC:", wbtcAddr);
    }
  } else {
    throw new Error("على mainnet: ضع عناوين USDC/WBTC الحقيقية هنا");
  }

  console.log("\nنشر MurabahaV6 كـ UUPS Proxy...");
  const Murabaha = await ethers.getContractFactory("MurabahaV6");

  const proxy = await upgrades.deployProxy(Murabaha, [
    usdcAddr,
    wbtcAddr,
    CHAINLINK_ETH_USD,
    CHAINLINK_BTC_USD,
    deployer.address, // brokerTreasury — غيّره لـ Gnosis Safe في الإنتاج
    deployer.address  // protocolTreasury
  ], {
    kind: "uups",
    initializer: "initialize",
    unsafeAllow: ["constructor"] as const,
  });

  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  const implAddr = await upgrades.erc1967.getImplementationAddress(proxyAddr);

  console.log("\n✅ تم النشر بنجاح!");
  console.log("=== العناوين (احفظها في project_state.md) ===");
  console.log("Proxy (العنوان الثابت ← هذا ما تستخدمه):  ", proxyAddr);
  console.log("Implementation (الكود الفعلي — يتغير عند الترقية):", implAddr);
  console.log("MockUSDC:", usdcAddr);
  console.log("MockWBTC:", wbtcAddr);
  console.log("ETH/USD feed:", CHAINLINK_ETH_USD);
  console.log("BTC/USD feed:", CHAINLINK_BTC_USD);

  console.log("\n=== ✅ POST-DEPLOY CHECKLIST ===");
  console.log("[ ] 1. حدّث configV6.js: CONTRACT_V6 =", proxyAddr);
  console.log("[ ] 2. حدّث configV6.js: USDC_ADDRESS =", usdcAddr);
  console.log("[ ] 3. حدّث configV6.js: WBTC_ADDRESS =", wbtcAddr);
  console.log("[ ] 4. حدّث ABI في configV6.js (من artifacts/)");
  console.log("[ ] 5. npm run build في hlal5-ui/");
  console.log("[ ] 6. vercel --prod --yes");
  console.log("[ ] 7. ⭐ Chainlink Automation (مرة واحدة للأبد بسبب الـ Proxy):");
  console.log("       automation.chain.link/sepolia → Register → Custom Logic →", proxyAddr);
  console.log("[ ] 8. تحقق: عداد يصل صفر → قسط يُخصم تلقائياً");
  console.log("[ ] 9. حدّث project_state.md بالعناوين الجديدة");

  console.log("\n=== الترقية المستقبلية (بدون إعادة تسجيل Chainlink) ===");
  console.log("npx hardhat run scripts/upgrade-v6.ts --network sepolia");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

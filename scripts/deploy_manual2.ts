import { ethers } from "hardhat";

const CHAINLINK_ETH_USD = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const CHAINLINK_BTC_USD = "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F";
const USDC_BASE         = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CBBTC_BASE        = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // الخطوة 1: نشر Implementation
  console.log("\n1️⃣  نشر Implementation...");
  const Murabaha = await ethers.getContractFactory("MurabahaV6");
  const impl = await Murabaha.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("   ✅ Implementation:", implAddr);

  // الخطوة 2: نشر ERC1967Proxy
  console.log("\n2️⃣  نشر ERC1967Proxy...");
  const { abi: proxyAbi, bytecode: proxyBytecode } = 
    require("/Users/macmjls/Downloads/hlal_v6_project/node_modules/@openzeppelin/contracts/build/contracts/ERC1967Proxy.json");

  const initData = Murabaha.interface.encodeFunctionData("initialize", [
    USDC_BASE, CBBTC_BASE, CHAINLINK_ETH_USD, CHAINLINK_BTC_USD,
    deployer.address, deployer.address
  ]);

  const ProxyFactory = new ethers.ContractFactory(proxyAbi, proxyBytecode, deployer);
  const proxy = await ProxyFactory.deploy(implAddr, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();

  console.log("   ✅ Proxy:", proxyAddr);

  // تحقق من الـ implementation slot
  const slot = await ethers.provider.getStorage(
    proxyAddr,
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
  );
  const storedImpl = ethers.getAddress("0x" + slot.slice(26));
  console.log("   ERC1967 impl slot:", storedImpl);

  console.log("\n════════════════════════════════════");
  console.log("✅ تم النشر على Base Mainnet!");
  console.log("  Proxy (ثابت)   :", proxyAddr);
  console.log("  Implementation :", implAddr);
  console.log("  USDC           :", USDC_BASE);
  console.log("  cbBTC          :", CBBTC_BASE);
  console.log("════════════════════════════════════");
  console.log("\nالخطوة التالية:");
  console.log("  npx hardhat verify --network base", implAddr);
  console.log("  basescan.org/address/" + proxyAddr);
}

main().catch(e => { console.error(e); process.exitCode = 1; });

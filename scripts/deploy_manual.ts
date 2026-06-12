import { ethers, upgrades } from "hardhat";

const CHAINLINK_ETH_USD = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const CHAINLINK_BTC_USD = "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F";
const USDC_BASE         = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CBBTC_BASE        = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Nonce:", await ethers.provider.getTransactionCount(deployer.address));

  // الخطوة 1: نشر Implementation فقط
  console.log("\n1️⃣  نشر Implementation...");
  const Murabaha = await ethers.getContractFactory("MurabahaV6");
  const impl = await Murabaha.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("   Implementation:", implAddr);

  // الخطوة 2: نشر الـ Proxy يدوياً
  console.log("\n2️⃣  نشر UUPS Proxy يدوياً...");
  const ERC1967ProxyABI = [
    "constructor(address implementation, bytes data) payable"
  ];
  // encode initialize call
  const initData = Murabaha.interface.encodeFunctionData("initialize", [
    USDC_BASE, CBBTC_BASE, CHAINLINK_ETH_USD, CHAINLINK_BTC_USD,
    deployer.address, deployer.address
  ]);
  
  const ProxyFactory = await ethers.getContractFactory(
    ["constructor(address,bytes) payable"],
    "0x" // bytecode - نحتاج ERC1967Proxy bytecode
  );
  
  // استخدام OpenZeppelin ERC1967Proxy
  const { bytecode } = require("@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol/ERC1967Proxy.json");
  const ProxyDeploy = new ethers.ContractFactory(
    ["constructor(address _logic, bytes _data)"],
    bytecode,
    deployer
  );
  
  const proxy = await ProxyDeploy.deploy(implAddr, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log("   Proxy:", proxyAddr);
  console.log("\n✅ تم! Proxy:", proxyAddr, "| Impl:", implAddr);
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });

import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import * as dotenv from "dotenv";
dotenv.config();

const SEPOLIA_RPC   = process.env.SEPOLIA_RPC_URL   || "";
const BASE_RPC      = process.env.BASE_RPC_URL       || "https://mainnet.base.org";
const PRIVATE_KEY   = process.env.PRIVATE_KEY        || "";
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY  || "";
// BUG-045: Etherscan V2 API يستخدم نفس الـ key لكل الشبكات (Base/Sepolia/...)
const BASESCAN_KEY  = process.env.BASESCAN_API_KEY   || ETHERSCAN_KEY;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.22",
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: {},
    sepolia: {
      url: SEPOLIA_RPC,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    base: {
      url: BASE_RPC,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 8453,
    },
  },
  // Etherscan V2 — مفتاح واحد لكل الشبكات
  etherscan: {
    apiKey: ETHERSCAN_KEY,
  },
};

export default config;

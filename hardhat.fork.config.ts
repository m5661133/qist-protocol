import base from "./hardhat.config";

/** محاكاة الترقية على نسخة من Base: FORK_BLOCK اختياري (الافتراضي آخر كتلة). لا يرسل شيئاً إلى Base. */
const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const config = {
  ...base,
  networks: {
    ...base.networks,
    hardhat: {
      hardfork: "cancun",
      forking: { url: BASE_RPC, ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}) },
      chains: { 8453: { hardforkHistory: { cancun: 0 } } },
    },
  },
};
export default config;

import { ethers } from "hardhat";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const ABI = [
  "function protocolTreasury() view returns (address)",
  "function brokerTreasury() view returns (address)",
  "function getSupportedTokens() view returns (address[])",
  "function quotePrice(address) view returns (uint256)",
];

async function main() {
  const code = await ethers.provider.getCode(PROXY);
  console.log("Code length:", code.length, code === "0x" ? "❌ لا يوجد كود" : "✅");

  try {
    const p = new ethers.Contract(PROXY, ABI, ethers.provider);
    const pt = await p.protocolTreasury();
    const bt = await p.brokerTreasury();
    const tokens = await p.getSupportedTokens();
    console.log("protocolTreasury:", pt);
    console.log("brokerTreasury  :", bt);
    console.log("supportedTokens :", tokens);
    // quote ETH price
    const ethPrice = await p.quotePrice(ethers.ZeroAddress);
    console.log("ETH price       : $" + (Number(ethPrice)/1e6).toFixed(2));
    console.log("\n✅ العقد يعمل بشكل صحيح على Base!");
  } catch(e: any) {
    console.log("❌ خطأ:", e.message);
  }
}
main().catch(console.error);

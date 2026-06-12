import { ethers } from "hardhat";

const FEEDS = [
  { name: "ETH/USD", addr: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" },
  { name: "BTC/USD", addr: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F" },
];

const ABI = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"];

async function main() {
  for (const f of FEEDS) {
    try {
      const code = await ethers.provider.getCode(f.addr);
      if (code === "0x") { console.log(`❌ ${f.name}: لا يوجد كود على هذا العنوان!`); continue; }
      const feed = new ethers.Contract(f.addr, ABI, ethers.provider);
      const [, price] = await feed.latestRoundData();
      console.log(`✅ ${f.name}: $${(Number(price)/1e8).toFixed(2)}`);
    } catch(e: any) {
      console.log(`❌ ${f.name}: ${e.message}`);
    }
  }
}
main().catch(console.error);

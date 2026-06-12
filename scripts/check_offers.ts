import { ethers } from "hardhat";
const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const ABI = [
  "function nextOfferId() view returns (uint256)",
  "function getOffer(uint256) view returns (tuple(address seller,address saleToken,address collateralToken,address paymentToken,uint256 totalAmount,uint256 saleAmount,uint256 minPurchaseAmount,uint16 profitBps,uint8 minInstallments,uint8 maxInstallments,uint32 paymentInterval,uint16 collateralRatioBps,uint8 state))",
];
const ETH = "0x0000000000000000000000000000000000000000";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const name = (a: string) => a === ETH ? "ETH" : a?.toLowerCase() === USDC.toLowerCase() ? "USDC" : a?.toLowerCase() === CBBTC.toLowerCase() ? "cbBTC" : a;
const states = ["نشط","مغلق"];

async function main() {
  const pool = new ethers.Contract(PROXY, ABI, ethers.provider);
  const next = await pool.nextOfferId();
  console.log("══ العروض ══");
  for (let i = 1; i < Number(next); i++) {
    const o = await pool.getOffer(i);
    console.log(`\nعرض #${i}: ${states[Number(o.state)]}`);
    console.log(`  البائع     : ${o.seller}`);
    console.log(`  يبيع       : ${name(o.saleToken)}`);
    console.log(`  الضمان     : ${name(o.collateralToken)} ← المشتري يضمن بهذا`);
    console.log(`  الدفع      : ${name(o.paymentToken)}`);
    console.log(`  الكمية     : ${ethers.formatEther(o.saleAmount)} ${name(o.saleToken)}`);
    console.log(`  الربح      : ${o.profitBps/100}%`);
  }
}
main().catch(console.error);

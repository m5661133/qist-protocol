import { ethers } from "ethers";
const RPC = "https://base-rpc.publicnode.com";
const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const WBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const ETH = ethers.ZeroAddress;
const ABI = ["function quotePrice(address) view returns (uint256)"];
const main = async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const contract = new ethers.Contract(PROXY, ABI, provider);
  const ethPrice = await contract.quotePrice(ETH);
  const wbtcPrice = await contract.quotePrice(WBTC);
  console.log("ETH  price (USDC 6dec):", ethPrice.toString(), "= $" + (Number(ethPrice)/1e6).toFixed(2));
  console.log("WBTC price (USDC 6dec):", wbtcPrice.toString(), "= $" + (Number(wbtcPrice)/1e6).toFixed(2));
};
main().catch(e => console.error(e));

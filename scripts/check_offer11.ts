import { ethers } from "ethers";

const RPC = "https://base-rpc.publicnode.com";
const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";

const ABI = [
  "function getOffer(uint256 id) view returns (tuple(address seller, address saleToken, address collateralToken, address paymentToken, uint256 totalAmount, uint256 saleAmount, uint256 minPurchaseAmount, uint16 profitBps, uint8 minInstallments, uint8 maxInstallments, uint32 paymentInterval, uint16 collateralRatioBps, uint8 state))",
  "function quotePrice(address token) view returns (uint256)",
];

const main = async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const contract = new ethers.Contract(PROXY, ABI, provider);

  console.log("📋 Reading Offer #11 directly from Base Mainnet...\n");

  const offer = await contract.getOffer(11);
  console.log("Seller:               ", offer.seller);
  console.log("Sale Token:           ", offer.saleToken, offer.saleToken === ethers.ZeroAddress ? "(ETH)" : "(ERC20)");
  console.log("Collateral Token:     ", offer.collateralToken);
  console.log("Payment Token:        ", offer.paymentToken);
  console.log("Total Amount (raw):   ", offer.totalAmount.toString());
  console.log("Sale Amount (raw):    ", offer.saleAmount.toString());
  console.log("Min Purchase (raw):   ", offer.minPurchaseAmount.toString());
  console.log("Profit BPS:           ", offer.profitBps.toString(), "(=", Number(offer.profitBps)/100, "%)");
  console.log("Min Installments:     ", offer.minInstallments.toString());
  console.log("Max Installments:     ", offer.maxInstallments.toString());
  console.log("Payment Interval:     ", offer.paymentInterval.toString(), "seconds");
  console.log("Collateral Ratio BPS: ", offer.collateralRatioBps.toString(), "(=", Number(offer.collateralRatioBps)/100, "%)");
  console.log("State:                ", offer.state.toString(), offer.state === 0n ? "(ACTIVE)" : "(CANCELLED)");

  const isEth = offer.saleToken === ethers.ZeroAddress;
  const decimals = isEth ? 18 : 8;
  const totalHuman = Number(offer.totalAmount) / 10**decimals;
  const saleHuman = Number(offer.saleAmount) / 10**decimals;
  const minPurchaseHuman = Number(offer.minPurchaseAmount) / 10**decimals;

  console.log("\n📐 Human-readable amounts:");
  console.log(`Total Amount:        ${totalHuman} ${isEth ? "ETH" : "WBTC"}`);
  console.log(`Sale Amount:         ${saleHuman} ${isEth ? "ETH" : "WBTC"}`);
  console.log(`Min Purchase:        ${minPurchaseHuman} ${isEth ? "ETH" : "WBTC"}`);

  console.log("\n💵 Current price from Chainlink:");
  const price = await contract.quotePrice(offer.saleToken);
  const priceUsd = Number(price) / 1e6;
  console.log(`Token Price:         $${priceUsd.toFixed(2)} per unit`);

  console.log("\n📊 Deal value calculation:");
  console.log(`Sale Value:          $${(saleHuman * priceUsd).toFixed(4)}`);
  console.log(`With Profit (${Number(offer.profitBps)/100}%): $${(saleHuman * priceUsd * (1 + Number(offer.profitBps)/10000)).toFixed(4)}`);
  console.log(`Per installment (max ${offer.maxInstallments}): $${(saleHuman * priceUsd * (1 + Number(offer.profitBps)/10000) / Number(offer.maxInstallments)).toFixed(4)}`);
};

main().catch(e => { console.error("Error:", e.message); process.exit(1); });

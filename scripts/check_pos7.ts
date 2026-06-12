import { ethers } from "ethers";
const RPC = "https://base-rpc.publicnode.com";
const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const ABI = [
  "function getPosition(uint256 id) view returns (tuple(uint256 offerId, address buyer, address saleToken, address collateralToken, address paymentToken, uint256 saleAmount, uint256 collateralAmount, uint256 totalPayable, uint8 totalInstallments, uint8 paidInstallments, uint32 paymentInterval, uint256 nextDueDate, uint8 state))",
  "function healthFactor(uint256 id) view returns (uint256)",
  "function isLiquidatable(uint256 id) view returns (bool, string)",
  "function getInstallmentAmount(uint256 id) view returns (uint256)",
  "function getRemainingDebt(uint256 id) view returns (uint256)",
];

const main = async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const contract = new ethers.Contract(PROXY, ABI, provider);
  console.log("📋 Position #7 على Base Mainnet\n");
  const pos = await contract.getPosition(7);
  const isEthSale = pos.saleToken === ethers.ZeroAddress;
  const decimals = isEthSale ? 18 : 8;
  
  console.log("Buyer:           ", pos.buyer);
  console.log("Offer ID:        ", pos.offerId.toString());
  console.log("Sale Token:      ", isEthSale ? "ETH" : pos.saleToken);
  console.log("Collateral:      ", pos.collateralToken === ethers.ZeroAddress ? "ETH" : pos.collateralToken);
  console.log("Sale Amount:     ", (Number(pos.saleAmount)/10**decimals).toFixed(10), isEthSale ? "ETH" : "WBTC");
  console.log("Collateral:      ", (Number(pos.collateralAmount)/1e18).toFixed(10), "ETH");
  console.log("Total Payable:   ", "$" + (Number(pos.totalPayable)/1e6).toFixed(4));
  console.log("Installments:    ", pos.paidInstallments + "/" + pos.totalInstallments + " مدفوع");
  console.log("Payment Interval:", pos.paymentInterval + "s (" + (Number(pos.paymentInterval)/60).toFixed(1) + "min)");
  console.log("Next Due:        ", new Date(Number(pos.nextDueDate) * 1000).toLocaleString());
  
  const stateNames = ["ACTIVE", "COMPLETED", "LIQUIDATED"];
  const stateName = stateNames[Number(pos.state)] || "UNKNOWN";
  console.log("State:           ", pos.state.toString(), "= " + stateName);
  
  try { const hf = await contract.healthFactor(7); console.log("Health Factor:   ", (Number(hf)/100).toFixed(2) + "%"); } catch (e: any) { console.log("Health Factor:   ", "N/A"); }
  try { const [liq, reason] = await contract.isLiquidatable(7); console.log("Liquidatable:    ", liq ? "✓ YES — " + reason : "✗ NO"); } catch (e: any) {}
  try { const inst = await contract.getInstallmentAmount(7); console.log("Installment Amt: ", "$" + (Number(inst)/1e6).toFixed(6)); } catch (e: any) { console.log("Installment Amt: ", "N/A"); }
  try { const debt = await contract.getRemainingDebt(7); console.log("Remaining Debt:  ", "$" + (Number(debt)/1e6).toFixed(6)); } catch (e: any) {}
  
  const now = Math.floor(Date.now() / 1000);
  const due = Number(pos.nextDueDate);
  if (due > now) console.log("Next payment in: ", (due - now) + "s");
  else console.log("Overdue by:      ", ((now - due)/60).toFixed(1) + "min");
  
  console.log("\n💡 الخلاصة:");
  if (Number(pos.state) === 0) {
    if (Number(pos.paidInstallments) >= Number(pos.totalInstallments)) {
      console.log("   ⚠️ الحالة ACTIVE لكن كل الأقساط مدفوعة — يجب على الـ keeper استدعاء performUpkeep لتغيير الحالة إلى COMPLETED");
      console.log("   💸 ETH يجب يكون موجود في pendingETH(buyer) — اسحبه من المحفظة");
    } else {
      console.log("   ✅ ACTIVE — تقدر تدفع باقي الأقساط أو تنهيه مبكراً");
    }
  } else if (Number(pos.state) === 1) {
    console.log("   ✅ COMPLETED — انتهى. ETH في pendingETH(buyer) — اسحبه من المحفظة");
  } else if (Number(pos.state) === 2) {
    console.log("   🔴 LIQUIDATED — تمّ تصفيته. لا تقدر تدفع/تنهي");
  }
};
main().catch(e => { console.error("Error:", e.message); process.exit(1); });

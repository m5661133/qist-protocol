import { ethers } from "ethers";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const RPC = "https://base-rpc.publicnode.com";
const ABI = [
  "function getPosition(uint256 id) view returns (tuple(uint256 offerId, address buyer, address saleToken, address collateralToken, address paymentToken, uint256 saleAmount, uint256 collateralAmount, uint256 totalPayable, uint8 totalInstallments, uint8 paidInstallments, uint32 paymentInterval, uint256 nextDueDate, uint8 state))",
  "function getInstallmentAmount(uint256 positionId) view returns (uint256)",
  "function getRemainingDebt(uint256 positionId) view returns (uint256)",
  "function healthFactor(uint256 positionId) view returns (uint256)",
  "function isLiquidatable(uint256 positionId) view returns (bool, string)",
  "function checkUpkeep(bytes) view returns (bool, bytes)",
  "function GRACE_PERIOD() view returns (uint256)",
];

const STATES = ["ACTIVE", "COMPLETED", "LIQUIDATED"];

async function main() {
  const p = new ethers.JsonRpcProvider(RPC);
  const c = new ethers.Contract(PROXY, ABI, p);

  console.log("\n📊 Position #5 على Base Mainnet\n" + "=".repeat(50));
  const pos = await c.getPosition(5);
  const inst = await c.getInstallmentAmount(5);
  const debt = await c.getRemainingDebt(5);
  const hf = await c.healthFactor(5);
  const [liq, reason] = await c.isLiquidatable(5);
  const grace = await c.GRACE_PERIOD();

  const now = Math.floor(Date.now() / 1000);
  const dueIn = Number(pos.nextDueDate) - now;
  const dueText = dueIn > 0
    ? `بعد ${Math.floor(dueIn/3600)} س ${Math.floor((dueIn%3600)/60)} د`
    : `متأخر ${Math.floor(-dueIn/60)} د`;

  console.log(`المشتري:        ${pos.buyer}`);
  console.log(`الحالة:         ${STATES[pos.state]}`);
  console.log(`الكمية:         ${ethers.formatEther(pos.saleAmount)} ETH`);
  console.log(`الضمان:         ${(Number(pos.collateralAmount) / 1e8).toFixed(6)} cbBTC`);
  console.log(`إجمالي:         ${ethers.formatUnits(pos.totalPayable, 6)} USDC`);
  console.log(`الأقساط:        ${pos.paidInstallments}/${pos.totalInstallments}`);
  console.log(`القسط:          ${ethers.formatUnits(inst, 6)} USDC`);
  console.log(`المتبقّي:        ${ethers.formatUnits(debt, 6)} USDC`);
  console.log(`Health Factor:  ${(Number(hf)/100).toFixed(2)}%`);
  console.log(`القسط القادم:   ${dueText} (${new Date(Number(pos.nextDueDate)*1000).toLocaleString('ar')})`);
  console.log(`GRACE_PERIOD:   ${Number(grace)} ثانية (${Number(grace)/60} دقيقة)`);
  console.log(`قابل للتصفية:  ${liq} ${reason ? `(${reason})` : ""}`);

  console.log("\n🤖 Chainlink Automation:");
  const [needed, perfData] = await c.checkUpkeep("0x");
  console.log(`upkeepNeeded:   ${needed}`);
  if (needed) {
    const targetPos = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], perfData)[0];
    console.log(`Target Position: #${targetPos}  ← Chainlink سيشغّل performUpkeep على هذا`);
  } else {
    console.log("لا يوجد upkeep مطلوب الآن (كل المراكز في الوقت)");
  }
}

main().catch(console.error);

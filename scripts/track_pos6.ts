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
];

const STATES = ["ACTIVE", "COMPLETED", "LIQUIDATED"];

async function check() {
  const p = new ethers.JsonRpcProvider(RPC);
  const c = new ethers.Contract(PROXY, ABI, p);
  const pos = await c.getPosition(6);
  const debt = await c.getRemainingDebt(6);
  const hf = await c.healthFactor(6);
  const [liq, reason] = await c.isLiquidatable(6);
  const [needed, perfData] = await c.checkUpkeep("0x");

  const now = Math.floor(Date.now() / 1000);
  const dueIn = Number(pos.nextDueDate) - now;
  let dueText;
  if (dueIn > 0) {
    dueText = `بعد ${Math.floor(dueIn/60)}:${String(dueIn%60).padStart(2,"0")}`;
  } else {
    const overdueSec = -dueIn;
    dueText = `⏰ متأخّر ${Math.floor(overdueSec/60)}:${String(overdueSec%60).padStart(2,"0")}`;
  }

  let targetPos = "—";
  if (needed) {
    try {
      targetPos = "#" + ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], perfData)[0].toString();
    } catch {}
  }

  const ts = new Date().toLocaleTimeString('ar');
  console.log(
    `[${ts}] الحالة:${STATES[pos.state]} | الأقساط:${pos.paidInstallments}/${pos.totalInstallments} | متبقّي:${ethers.formatUnits(debt,6)} | HF:${(Number(hf)/100).toFixed(0)}% | ${dueText} | tobeLiq:${liq} | upkeepNeeded:${needed} ${needed?`(target ${targetPos})`:""}`
  );
}

async function main() {
  console.log("🔍 تتبّع Position #6 (دقيقتين) — كل 10 ثوان\n");
  for (let i = 0; i < 30; i++) {
    try { await check(); } catch (e) { console.log("خطأ:", e.message); }
    await new Promise(r => setTimeout(r, 10000));
  }
}

main();

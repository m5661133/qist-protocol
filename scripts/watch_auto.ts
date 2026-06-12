import { ethers } from "ethers";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const REGISTRY = "0xf4bAb6A129164aBa9B113cB96BA4266dF49f8743";
const RPC = "https://base-rpc.publicnode.com";

const ABI = [
  "function getPosition(uint256 id) view returns (tuple(uint256 offerId, address buyer, address saleToken, address collateralToken, address paymentToken, uint256 saleAmount, uint256 collateralAmount, uint256 totalPayable, uint8 totalInstallments, uint8 paidInstallments, uint32 paymentInterval, uint256 nextDueDate, uint8 state))",
  "function getRemainingDebt(uint256) view returns (uint256)",
  "function healthFactor(uint256) view returns (uint256)",
  "function isLiquidatable(uint256) view returns (bool, string)",
  "function checkUpkeep(bytes) view returns (bool, bytes)",
  "event PositionLiquidated(uint256 indexed positionId, uint256 sellerCollateral, uint256 buyerRefund, string reason)",
  "event InstallmentPaid(uint256 indexed positionId, uint8 installment, uint256 amount)",
];

const REG_ABI = [
  "function getMinBalance(uint256) view returns (uint96)",
  "function getUpkeep(uint256) view returns (tuple(address target, uint32 performGas, bytes checkData, uint96 balance, address admin, uint64 maxValidBlocknumber, uint32 lastPerformedBlockNumber, uint96 amountSpent, bool paused, bytes offchainConfig))",
];

const STATES = ["ACTIVE", "COMPLETED", "LIQUIDATED"];
const UPKEEP_ID = "110042143417764654920263698666520432147413168623444033995195056110833210534833";

async function check(p: any, c: any, r: any, last: any) {
  const pos = await c.getPosition(6);
  const debt = await c.getRemainingDebt(6);
  const hf = await c.healthFactor(6);
  const [liq] = await c.isLiquidatable(6);
  const [needed] = await c.checkUpkeep("0x");
  const upkeep = await r.getUpkeep(UPKEEP_ID);
  const minBal = await r.getMinBalance(UPKEEP_ID);

  const now = Math.floor(Date.now() / 1000);
  const dueIn = Number(pos.nextDueDate) - now;
  const dueText = dueIn > 0
    ? `بعد ${Math.floor(dueIn/60)}:${String(dueIn%60).padStart(2,"0")}`
    : `⏰متأخّر ${Math.floor(-dueIn/60)}:${String(-dueIn%60).padStart(2,"0")}`;

  const bal = Number(upkeep.balance) / 1e18;
  const min = Number(minBal) / 1e18;
  const spent = Number(upkeep.amountSpent) / 1e18;
  const lastBlock = Number(upkeep.lastPerformedBlockNumber);

  const ts = new Date().toLocaleTimeString('ar');
  const stateChanged = STATES[pos.state] !== last.state;
  const paidChanged = Number(pos.paidInstallments) !== last.paid;
  const blockChanged = lastBlock !== last.lastBlock && lastBlock > 0;

  console.log(
    `[${ts}] LINK:${bal.toFixed(2)}/${min.toFixed(2)} spent:${spent.toFixed(4)} | ${STATES[pos.state]} ${pos.paidInstallments}/${pos.totalInstallments} | متبقّي:${ethers.formatUnits(debt,6)} | HF:${(Number(hf)/100).toFixed(0)}% | ${dueText} | liq:${liq} | needed:${needed} | lastExec:${lastBlock}` +
    (blockChanged ? "  🚨 Chainlink نفّذ معاملة!" : "") +
    (stateChanged ? `  🚨 الحالة تغيّرت → ${STATES[pos.state]}` : "") +
    (paidChanged ? `  🚨 قسط جديد مدفوع!` : "")
  );

  return { state: STATES[pos.state], paid: Number(pos.paidInstallments), lastBlock };
}

async function main() {
  const p = new ethers.JsonRpcProvider(RPC);
  const c = new ethers.Contract(PROXY, ABI, p);
  const r = new ethers.Contract(REGISTRY, REG_ABI, p);

  console.log("🔴 مراقبة مباشرة لـ Position #6 + Chainlink Upkeep — كل 10 ثوان لـ 5 دقائق\n");

  let last = { state: "", paid: -1, lastBlock: 0 };
  for (let i = 0; i < 30; i++) {
    try { last = await check(p, c, r, last); } catch (e: any) { console.log("خطأ:", e.message); }
    if (last.state === "LIQUIDATED" || last.state === "COMPLETED") {
      console.log("\n✅ المركز انتهى — إيقاف المراقبة");
      break;
    }
    await new Promise(res => setTimeout(res, 10000));
  }
}
main();

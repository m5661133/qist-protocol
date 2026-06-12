const { ethers } = require("ethers");

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const ABI = [
  "function getPosition(uint256) view returns (tuple(uint256 offerId,address buyer,address saleToken,address collateralToken,address paymentToken,uint256 saleAmount,uint256 collateralAmount,uint256 totalPayable,uint8 totalInstallments,uint8 paidInstallments,uint32 paymentInterval,uint256 nextDueDate,uint8 state))",
  "function nextPositionId() view returns (uint256)",
  "function healthFactor(uint256) view returns (uint256)",
  "function getRemainingDebt(uint256) view returns (uint256)",
  "function getInstallmentAmount(uint256) view returns (uint256)",
  "function GRACE_PERIOD() view returns (uint256)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider("https://base-rpc.publicnode.com");
  const c = new ethers.Contract(PROXY, ABI, provider);
  const now = Math.floor(Date.now() / 1000);

  const nextId = Number(await c.nextPositionId());
  let grace = 0; try { grace = Number(await c.GRACE_PERIOD()); } catch {}
  console.log(`إجمالي المراكز: ${nextId - 1} | GRACE_PERIOD=${grace}s | الوقت الآن ${new Date(now*1000).toISOString()}\n`);

  const stateMap = ["نشط 🟢", "مكتمل ✅", "مصفّى 🔴"];
  const fU = (x) => (x == null ? "—" : Number(ethers.formatUnits(x, 6)).toLocaleString("en-US",{maximumFractionDigits:4}) + " USDC");

  for (let id = 1; id < nextId; id++) {
    let p;
    try { p = await c.getPosition(id); } catch { continue; }
    const state = Number(p.state);
    let debt = null, inst = null, hf = null;
    try { debt = await c.getRemainingDebt(id); } catch {}
    try { inst = await c.getInstallmentAmount(id); } catch {}
    try { hf = await c.healthFactor(id); } catch {}
    const nextDue = Number(p.nextDueDate);
    const lateInfo = state === 0 && now > nextDue ? `متأخر ${Math.floor((now-nextDue)/60)}د` : (state===0 ? `باقٍ ${Math.max(0,Math.floor((nextDue-now)/60))}د` : "");
    const buyer = `${p.buyer.slice(0,6)}…${p.buyer.slice(-4)}`;
    console.log(`#${id} | عرض ${p.offerId} | ${stateMap[state] ?? p.state} | أقساط ${p.paidInstallments}/${p.totalInstallments} | إجمالي ${fU(p.totalPayable)} | متبقٍ ${fU(debt)} | قسط ${fU(inst)} | HF ${hf==null?'—':(Number(hf)/100).toFixed(0)+'%'} | ${lateInfo} | ${buyer}`);
  }
}
main().catch((e) => { console.error("ERROR:", e.shortMessage || e.message || e); process.exit(1); });

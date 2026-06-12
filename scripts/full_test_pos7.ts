import { ethers } from "ethers";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const REGISTRY = "0xf4bAb6A129164aBa9B113cB96BA4266dF49f8743";
const RPC = "https://base-rpc.publicnode.com";
const SELLER = "0x5e235cDCd43BCD3a3CB625cdC2c90fDAA443F117";
const BUYER  = "0xBaA8CeF9f1CE60aed41D62ca12Fe490691697d74";
const POS_ID = 7;
const UPKEEP_ID = "110042143417764654920263698666520432147413168623444033995195056110833210534833";

const ABI = [
  "function getPosition(uint256) view returns (tuple(uint256 offerId, address buyer, address saleToken, address collateralToken, address paymentToken, uint256 saleAmount, uint256 collateralAmount, uint256 totalPayable, uint8 totalInstallments, uint8 paidInstallments, uint32 paymentInterval, uint256 nextDueDate, uint8 state))",
  "function getRemainingDebt(uint256) view returns (uint256)",
  "function healthFactor(uint256) view returns (uint256)",
  "function isLiquidatable(uint256) view returns (bool, string)",
  "function checkUpkeep(bytes) view returns (bool, bytes)",
  "function pendingETH(address) view returns (uint256)",
];

const USDC_ABI = ["function balanceOf(address) view returns (uint256)"];
const REG_ABI = [
  "function getMinBalance(uint256) view returns (uint96)",
  "function getUpkeep(uint256) view returns (tuple(address target, uint32 performGas, bytes checkData, uint96 balance, address admin, uint64 maxValidBlocknumber, uint32 lastPerformedBlockNumber, uint96 amountSpent, bool paused, bytes offchainConfig))",
];

const STATES = ["ACTIVE", "COMPLETED", "LIQUIDATED"];

async function snapshot(p: any, c: any, u: any, r: any, label: string) {
  const sETH = await p.getBalance(SELLER);
  const sUSDC = await u.balanceOf(SELLER);
  const sPending = await c.pendingETH(SELLER);
  const bETH = await p.getBalance(BUYER);
  const bUSDC = await u.balanceOf(BUYER);
  const bPending = await c.pendingETH(BUYER);
  const pos = await c.getPosition(POS_ID);
  const debt = await c.getRemainingDebt(POS_ID);
  const hf = await c.healthFactor(POS_ID);
  const [liq, reason] = await c.isLiquidatable(POS_ID);
  const upkeep = await r.getUpkeep(UPKEEP_ID);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📸 ${label}    ${new Date().toLocaleString('ar')}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🛒 البائع (${SELLER.slice(0,6)}...${SELLER.slice(-4)}):`);
  console.log(`   ETH: ${ethers.formatEther(sETH)} | USDC: ${ethers.formatUnits(sUSDC,6)} | pendingETH: ${ethers.formatEther(sPending)}`);
  console.log(`👤 المشتري (${BUYER.slice(0,6)}...${BUYER.slice(-4)}):`);
  console.log(`   ETH: ${ethers.formatEther(bETH)} | USDC: ${ethers.formatUnits(bUSDC,6)} | pendingETH: ${ethers.formatEther(bPending)}`);
  console.log(`📊 Position #${POS_ID}:`);
  console.log(`   الحالة: ${STATES[pos.state]} | الأقساط: ${pos.paidInstallments}/${pos.totalInstallments}`);
  console.log(`   الكمية: ${ethers.formatEther(pos.saleAmount)} ETH | الضمان: ${ethers.formatEther(pos.collateralAmount)} ETH`);
  console.log(`   إجمالي: ${ethers.formatUnits(pos.totalPayable,6)} USDC | متبقّي: ${ethers.formatUnits(debt,6)} USDC`);
  console.log(`   HF: ${(Number(hf)/100).toFixed(2)}% | قابل للتصفية: ${liq} ${reason ? `(${reason})` : ''}`);
  const dueIn = Number(pos.nextDueDate) - Math.floor(Date.now()/1000);
  console.log(`   القسط القادم: ${dueIn > 0 ? `بعد ${Math.floor(dueIn/60)}:${String(dueIn%60).padStart(2,'0')}` : `⏰ متأخر ${Math.floor(-dueIn/60)}:${String(-dueIn%60).padStart(2,'0')}`}`);
  console.log(`⚡ Chainlink Upkeep:`);
  console.log(`   الرصيد: ${(Number(upkeep.balance)/1e18).toFixed(4)} LINK | الإنفاق: ${(Number(upkeep.amountSpent)/1e18).toFixed(4)} LINK | آخر تنفيذ block: ${upkeep.lastPerformedBlockNumber}`);

  return {
    sETH, sUSDC, sPending, bETH, bUSDC, bPending,
    posState: STATES[pos.state],
    paid: Number(pos.paidInstallments),
    debt: Number(debt),
    lastBlock: Number(upkeep.lastPerformedBlockNumber),
    spent: Number(upkeep.amountSpent),
  };
}

async function main() {
  const p = new ethers.JsonRpcProvider(RPC);
  const c = new ethers.Contract(PROXY, ABI, p);
  const u = new ethers.Contract(USDC, USDC_ABI, p);
  const r = new ethers.Contract(REGISTRY, REG_ABI, p);

  const initial = await snapshot(p, c, u, r, "📍 الحالة الأولية — قبل أي خصم");
  console.log(`\n🔴 بدء المراقبة كل 15 ثانية لمدة 10 دقائق...\n`);

  let last = initial;
  for (let i = 0; i < 40; i++) {
    await new Promise(res => setTimeout(res, 15000));
    try {
      const now = await snapshot(p, c, u, r, `⏱️ تحديث ${i+1}/40`);

      // Detect changes
      const events: string[] = [];
      if (now.paid !== last.paid) events.push(`🚨 قسط جديد مدفوع! (${last.paid} → ${now.paid})`);
      if (now.posState !== last.posState) events.push(`🚨 الحالة تغيّرت: ${last.posState} → ${now.posState}`);
      if (now.lastBlock !== last.lastBlock && now.lastBlock > 0) events.push(`🚨 Chainlink نفّذ! block ${last.lastBlock} → ${now.lastBlock}`);
      if (now.spent !== last.spent) events.push(`💸 LINK المنفَق: ${((now.spent - last.spent) / 1e18).toFixed(4)} (الكلي: ${(now.spent/1e18).toFixed(4)})`);

      if (events.length > 0) {
        console.log(`\n${'★'.repeat(60)}`);
        events.forEach(e => console.log(e));
        console.log(`${'★'.repeat(60)}`);
      }

      if (now.posState === "COMPLETED" || now.posState === "LIQUIDATED") {
        console.log(`\n✅ المركز انتهى → ${now.posState}\n`);
        await snapshot(p, c, u, r, "📍 الحالة النهائية");
        break;
      }
      last = now;
    } catch (e: any) {
      console.log(`خطأ: ${e.message}`);
    }
  }
}
main();

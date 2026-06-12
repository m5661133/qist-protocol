import { ethers } from "ethers";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const RPC = "https://base-rpc.publicnode.com";

const ABI = [
  "event OfferCreated(uint256 indexed offerId, address indexed seller, address saleToken, address collateralToken, address paymentToken, uint256 amount, uint8 minInstallments, uint8 maxInstallments, uint32 paymentInterval, uint256 minPurchaseAmount)",
  "event Purchased(uint256 indexed positionId, uint256 indexed offerId, address indexed buyer, uint256 saleAmount, uint256 collateralAmount, uint256 totalPayable, uint8 selectedInstallments)",
  "event PartialPurchaseCreated(uint256 indexed positionId, uint256 indexed offerId, uint256 purchasedAmount, uint256 remainingInOffer)",
  "event InstallmentPaid(uint256 indexed positionId, uint8 installment, uint256 amount)",
  "event PositionCompleted(uint256 indexed positionId, uint256 collateralReturned)",
  "event PositionLiquidated(uint256 indexed positionId, uint256 sellerCollateral, uint256 buyerRefund, string reason)",
  "function nextOfferId() view returns (uint256)",
  "function nextPositionId() view returns (uint256)",
  "function getOffer(uint256) view returns (tuple(address seller, address saleToken, address collateralToken, address paymentToken, uint256 totalAmount, uint256 saleAmount, uint256 minPurchaseAmount, uint16 profitBps, uint8 minInstallments, uint8 maxInstallments, uint32 paymentInterval, uint16 collateralRatioBps, uint8 state))",
];

async function main() {
  const p = new ethers.JsonRpcProvider(RPC);
  const c = new ethers.Contract(PROXY, ABI, p);
  const cur = await p.getBlockNumber();
  const from = cur - 5000;
  console.log(`\n🔍 الأحداث (آخر 5000 block ≈ ساعتين)\n`);

  const created: any[] = [], purchased: any[] = [], partial: any[] = [];
  const paid: any[] = [], completed: any[] = [], liquidated: any[] = [];
  for (let f = from; f <= cur; f += 500) {
    const t = Math.min(f + 499, cur);
    try {
      const [c1,p1,pa1,pd1,cm1,l1] = await Promise.all([
        c.queryFilter("OfferCreated", f, t),
        c.queryFilter("Purchased", f, t),
        c.queryFilter("PartialPurchaseCreated", f, t),
        c.queryFilter("InstallmentPaid", f, t),
        c.queryFilter("PositionCompleted", f, t),
        c.queryFilter("PositionLiquidated", f, t),
      ]);
      created.push(...c1); purchased.push(...p1); partial.push(...pa1);
      paid.push(...pd1); completed.push(...cm1); liquidated.push(...l1);
    } catch { }
  }

  const events = [
    ...created.map((e:any) => ({ block: e.blockNumber, tx: e.transactionHash, kind: "📋 عرض جديد", details: `#${e.args.offerId} | ${e.args.seller.slice(0,6)}...${e.args.seller.slice(-4)} | الكمية: ${ethers.formatEther(e.args.amount)} ETH | ${e.args.minInstallments}-${e.args.maxInstallments} قسط | كل ${e.args.paymentInterval}s` })),
    ...purchased.map((e:any) => ({ block: e.blockNumber, tx: e.transactionHash, kind: "🛒 شراء", details: `Pos #${e.args.positionId} من العرض #${e.args.offerId} | المشتري: ${e.args.buyer.slice(0,6)}...${e.args.buyer.slice(-4)} | الكمية: ${ethers.formatEther(e.args.saleAmount)} ETH | إجمالي: ${ethers.formatUnits(e.args.totalPayable,6)} USDC | ${e.args.selectedInstallments} قسط` })),
    ...partial.map((e:any) => ({ block: e.blockNumber, tx: e.transactionHash, kind: "✂️ شراء جزئي", details: `Pos #${e.args.positionId} من #${e.args.offerId} | اشترى: ${ethers.formatEther(e.args.purchasedAmount)} ETH | باقي للبيع: ${ethers.formatEther(e.args.remainingInOffer)} ETH` })),
    ...paid.map((e:any) => ({ block: e.blockNumber, tx: e.transactionHash, kind: "💰 قسط", details: `Pos #${e.args.positionId} → قسط ${e.args.installment} | ${ethers.formatUnits(e.args.amount,6)} USDC` })),
    ...completed.map((e:any) => ({ block: e.blockNumber, tx: e.transactionHash, kind: "✅ اكتمال", details: `Pos #${e.args.positionId} | ضمان مُعاد: ${ethers.formatEther(e.args.collateralReturned)} ETH` })),
    ...liquidated.map((e:any) => ({ block: e.blockNumber, tx: e.transactionHash, kind: "🔴 تصفية", details: `Pos #${e.args.positionId} | للبائع: ${ethers.formatEther(e.args.sellerCollateral)} | للمشتري: ${ethers.formatEther(e.args.buyerRefund)} | السبب: ${e.args.reason}` })),
  ].sort((a, b) => a.block - b.block);

  if (events.length === 0) {
    console.log("لا توجد أحداث جديدة في الفترة الأخيرة.");
  } else {
    events.forEach(e => {
      console.log(`block ${e.block}: ${e.kind}`);
      console.log(`   ${e.details}`);
      console.log(`   tx: ${e.tx}`);
      console.log();
    });
  }

  // فحص العروض النشطة بالتفصيل
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📊 تفاصيل العروض النشطة:\n`);
  const nextOf = await c.nextOfferId();
  for (let i = 1; i < Number(nextOf); i++) {
    try {
      const o = await c.getOffer(i);
      if (o.state !== 0n || o.seller === ethers.ZeroAddress) continue;
      const sym = o.saleToken === ethers.ZeroAddress ? "ETH" : "WBTC";
      const dec = o.saleToken === ethers.ZeroAddress ? 18 : 8;
      console.log(`العرض #${i} (نشط):`);
      console.log(`   البائع:           ${o.seller}`);
      console.log(`   الكمية الأصلية:  ${ethers.formatUnits(o.totalAmount, dec)} ${sym}`);
      console.log(`   المتبقّي للبيع:   ${ethers.formatUnits(o.saleAmount, dec)} ${sym}`);
      console.log(`   مُباع منه:        ${ethers.formatUnits(o.totalAmount - o.saleAmount, dec)} ${sym}`);
      console.log(`   نسبة الربح:       ${Number(o.profitBps)/100}%`);
      console.log(`   الأقساط:         ${o.minInstallments} - ${o.maxInstallments}`);
      console.log(`   فترة الدفع:      ${o.paymentInterval}s (${Number(o.paymentInterval)/60} دقيقة)`);
      console.log(`   نسبة الضمان:     ${Number(o.collateralRatioBps)/100}%`);
      console.log();
    } catch {}
  }

  const nextPos = await c.nextPositionId();
  console.log(`عدد المراكز الكلي: ${Number(nextPos) - 1}`);
}
main().catch(console.error);

import { ethers } from "ethers";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const RPC = "https://base-rpc.publicnode.com";
const DEPLOY_BLOCK = 46500000; // تقريباً وقت نشر العقد على Base

const ABI = [
  "event OfferCreated(uint256 indexed offerId, address indexed seller, address saleToken, address collateralToken, address paymentToken, uint256 amount, uint8 minInstallments, uint8 maxInstallments, uint32 paymentInterval, uint256 minPurchaseAmount)",
  "event OfferCancelled(uint256 indexed offerId)",
  "event Purchased(uint256 indexed positionId, uint256 indexed offerId, address indexed buyer, uint256 saleAmount, uint256 collateralAmount, uint256 totalPayable, uint8 selectedInstallments)",
  "event InstallmentPaid(uint256 indexed positionId, uint8 installment, uint256 amount)",
  "event PositionCompleted(uint256 indexed positionId, uint256 collateralReturned)",
  "event PositionLiquidated(uint256 indexed positionId, uint256 sellerCollateral, uint256 buyerRefund, string reason)",
  "event EarlyRepaidCash(uint256 indexed positionId, uint256 amountPayment)",
  "event EarlyRepaidCollateral(uint256 indexed positionId, uint256 sellerCollateral, uint256 buyerRefund)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const contract = new ethers.Contract(PROXY, ABI, provider);
  const currentBlock = await provider.getBlockNumber();

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  📊 تحليل أحداث Qist Protocol — Base Mainnet            ║");
  console.log(`║  من block ${DEPLOY_BLOCK} إلى ${currentBlock}                          ║`);
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // جلب كل الأحداث على دفعات (Base يحدد 10000 block لكل query)
  const STEP = 10000;
  const allEvents: any = {
    created: [], cancelled: [], purchased: [], paid: [],
    completed: [], liquidated: [], earlyCash: [], earlyCol: []
  };

  for (let from = DEPLOY_BLOCK; from <= currentBlock; from += STEP) {
    const to = Math.min(from + STEP - 1, currentBlock);
    process.stdout.write(`فحص [${from}..${to}]...\r`);
    try {
      const [c, x, p, i, cm, l, ec, el] = await Promise.all([
        contract.queryFilter("OfferCreated", from, to),
        contract.queryFilter("OfferCancelled", from, to),
        contract.queryFilter("Purchased", from, to),
        contract.queryFilter("InstallmentPaid", from, to),
        contract.queryFilter("PositionCompleted", from, to),
        contract.queryFilter("PositionLiquidated", from, to),
        contract.queryFilter("EarlyRepaidCash", from, to),
        contract.queryFilter("EarlyRepaidCollateral", from, to),
      ]);
      allEvents.created.push(...c);
      allEvents.cancelled.push(...x);
      allEvents.purchased.push(...p);
      allEvents.paid.push(...i);
      allEvents.completed.push(...cm);
      allEvents.liquidated.push(...l);
      allEvents.earlyCash.push(...ec);
      allEvents.earlyCol.push(...el);
    } catch (e: any) {
      // skip errors
    }
  }

  console.log("\n");

  // 1. مؤشرات أساسية
  console.log("═══ 📈 المؤشرات الأساسية ═══\n");
  console.log(`  العروض المُنشأة:      ${allEvents.created.length}`);
  console.log(`  العروض الملغاة:       ${allEvents.cancelled.length}`);
  console.log(`  معدل الإلغاء:         ${((allEvents.cancelled.length / Math.max(1, allEvents.created.length)) * 100).toFixed(1)}%`);
  console.log(`  المشتريات:            ${allEvents.purchased.length}`);
  console.log(`  الأقساط المدفوعة:    ${allEvents.paid.length}`);
  console.log(`  المراكز المكتملة:    ${allEvents.completed.length}`);
  console.log(`  المراكز المصفّاة:     ${allEvents.liquidated.length}`);
  console.log(`  السداد المبكر نقداً: ${allEvents.earlyCash.length}`);
  console.log(`  السداد المبكر ضماناً: ${allEvents.earlyCol.length}`);

  // 2. مؤشرات صحة المنصة
  console.log("\n═══ 🩺 مؤشرات الصحة ═══\n");
  const totalFinished = allEvents.completed.length + allEvents.liquidated.length;
  const liqRate = totalFinished > 0 ? (allEvents.liquidated.length / totalFinished) * 100 : 0;
  const earlyRate = totalFinished > 0 ? ((allEvents.earlyCash.length + allEvents.earlyCol.length) / totalFinished) * 100 : 0;

  const liqEmoji = liqRate < 10 ? "🟢 ممتاز" : liqRate < 30 ? "🟡 مقبول" : "🔴 خطر";
  console.log(`  معدل التصفية:         ${liqRate.toFixed(1)}%  ${liqEmoji}`);
  console.log(`    (مؤشر صحي < 10% — مقبول < 30% — خطر ≥ 30%)`);
  console.log(`  معدل السداد المبكر:   ${earlyRate.toFixed(1)}%  ${earlyRate > 20 ? "🟢 إيجابي (ثقة)" : "⚪"}`);

  // 3. تحليل المستخدمين
  console.log("\n═══ 👥 تحليل المستخدمين ═══\n");
  const sellers = new Set(allEvents.created.map((e: any) => e.args.seller));
  const buyers = new Set(allEvents.purchased.map((e: any) => e.args.buyer));
  const allUsers = new Set([...sellers, ...buyers]);

  // المستخدمون المتكررون
  const buyerCounts: Record<string, number> = {};
  allEvents.purchased.forEach((e: any) => {
    buyerCounts[e.args.buyer] = (buyerCounts[e.args.buyer] || 0) + 1;
  });
  const returningBuyers = Object.values(buyerCounts).filter((c: any) => c >= 2).length;

  console.log(`  البائعون الفريدون:    ${sellers.size}`);
  console.log(`  المشترون الفريدون:    ${buyers.size}`);
  console.log(`  مستخدمون كلياً:       ${allUsers.size}`);
  console.log(`  مشترون عائدون (≥2):   ${returningBuyers}  ${returningBuyers > 0 ? "🟢" : "⚪"}`);
  if (buyers.size > 0) {
    console.log(`  نسبة الاحتفاظ:       ${((returningBuyers / buyers.size) * 100).toFixed(1)}%`);
  }

  // 4. تحليل حجم الصفقات
  console.log("\n═══ 💰 تحليل حجم الصفقات ═══\n");
  if (allEvents.purchased.length > 0) {
    const totalUSDC = allEvents.purchased.reduce((sum: bigint, e: any) => sum + e.args.totalPayable, 0n);
    const avgUSDC = totalUSDC / BigInt(allEvents.purchased.length);
    console.log(`  مجموع المعاملات:     ${ethers.formatUnits(totalUSDC, 6)} USDC`);
    console.log(`  متوسط الصفقة:        ${ethers.formatUnits(avgUSDC, 6)} USDC`);

    const installCounts = allEvents.purchased.map((e: any) => Number(e.args.selectedInstallments));
    const avgInstall = installCounts.reduce((s: number, c: number) => s + c, 0) / installCounts.length;
    console.log(`  متوسط عدد الأقساط:  ${avgInstall.toFixed(1)}`);
  }

  // 5. أحدث المعاملات
  console.log("\n═══ 🕐 آخر 5 معاملات (الأحدث) ═══\n");
  const recent = [
    ...allEvents.purchased.map((e: any) => ({ block: e.blockNumber, type: "شراء", details: `#${e.args.positionId}` })),
    ...allEvents.paid.map((e: any) => ({ block: e.blockNumber, type: "قسط", details: `#${e.args.positionId} → ${e.args.installment}` })),
    ...allEvents.completed.map((e: any) => ({ block: e.blockNumber, type: "اكتمال", details: `#${e.args.positionId}` })),
    ...allEvents.liquidated.map((e: any) => ({ block: e.blockNumber, type: "تصفية", details: `#${e.args.positionId} (${e.args.reason})` })),
  ].sort((a, b) => b.block - a.block).slice(0, 5);

  recent.forEach((r) => {
    console.log(`  block ${r.block}: ${r.type.padEnd(8)} ${r.details}`);
  });

  // 6. ملخص شامل + توصيات
  console.log("\n═══ 🎯 الخلاصة والتوصيات ═══\n");
  if (allEvents.purchased.length === 0) {
    console.log(`  ℹ️  لا توجد معاملات بعد — المشروع جديد.`);
  } else if (liqRate > 30) {
    console.log(`  ⚠️  معدل التصفية عالٍ (${liqRate.toFixed(1)}%) — راجع:`);
    console.log(`     • هل GRACE_PERIOD قصير جداً؟`);
    console.log(`     • هل Chainlink ممول دائماً؟`);
    console.log(`     • هل المستخدمون يفهمون آلية الأقساط؟`);
  } else if (allUsers.size < 10) {
    console.log(`  💡 المستخدمون قليلون (${allUsers.size}) — ركّز على:`);
    console.log(`     • التسويق على Twitter وTelegram`);
    console.log(`     • تبسيط onboarding (أول تجربة)`);
    console.log(`     • إضافة شروحات داخل التطبيق`);
  } else {
    console.log(`  ✅ مؤشرات صحية — استمر بمراقبة:`);
    console.log(`     • معدل النمو الأسبوعي`);
    console.log(`     • معدل الاحتفاظ بالمستخدمين`);
    console.log(`     • أحجام الصفقات المتنامية`);
  }

  console.log("\n💡 شغّل هذا السكريبت أسبوعياً وتابع المؤشرات.\n");
}
main().catch(console.error);

/**
 * deploy_build17 — نشر Build 17 وترقية الـ Proxy على Base Mainnet مع تحقّق فوري.
 * يُشغّل: npx hardhat run scripts/deploy_build17.ts --network base
 *
 * يفعل:
 *  1. لقطة قبل الترقية (owner/nextIds/offer13/pos8)
 *  2. نشر implementation جديد (Build 17)
 *  3. proxy.upgradeToAndCall(newImpl, "0x")
 *  4. لقطة بعد + مقارنة (يكشف أي تلف storage فوراً)
 *  5. تفعيل H2: setSequencerUptimeFeed(Base feed)
 */
import { ethers } from "hardhat";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const BASE_SEQUENCER_FEED = "0xBCF85224fc0756B9Fa45aA7892530B47e10b6433";

const SNAP_ABI = [
  "function owner() view returns (address)",
  "function nextOfferId() view returns (uint256)",
  "function nextPositionId() view returns (uint256)",
  "function protocolFeeBps() view returns (uint16)",
  "function brokerageFeeBps() view returns (uint16)",
  "function getOffer(uint256) view returns (tuple(address seller,address saleToken,address collateralToken,address paymentToken,uint256 totalAmount,uint256 saleAmount,uint256 minPurchaseAmount,uint16 profitBps,uint8 minInstallments,uint8 maxInstallments,uint32 paymentInterval,uint16 collateralRatioBps,uint8 state,bool autoLiquidateEnabled))",
  "function getPosition(uint256) view returns (tuple(uint256 offerId,address buyer,address saleToken,address collateralToken,address paymentToken,uint256 saleAmount,uint256 collateralAmount,uint256 totalPayable,uint8 totalInstallments,uint8 paidInstallments,uint32 paymentInterval,uint256 nextDueDate,uint8 state,bool autoPayEnabled))",
];

async function snap(provider: any) {
  const c = new ethers.Contract(PROXY, SNAP_ABI, provider);
  const o13 = await c.getOffer(13).catch(() => null);
  const p8 = await c.getPosition(8).catch(() => null);
  return {
    owner: await c.owner(),
    nextOfferId: (await c.nextOfferId()).toString(),
    nextPositionId: (await c.nextPositionId()).toString(),
    protocolFeeBps: (await c.protocolFeeBps()).toString(),
    brokerageFeeBps: (await c.brokerageFeeBps()).toString(),
    o13_seller: o13 ? o13.seller : "—",
    o13_profitBps: o13 ? o13.profitBps.toString() : "—",
    p8_buyer: p8 ? p8.buyer : "—",
    p8_totalPayable: p8 ? p8.totalPayable.toString() : "—",
    p8_state: p8 ? p8.state.toString() : "—",
  };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("🚀 نشر Build 17 على Base Mainnet");
  console.log("الناشر:", deployer.address);

  // 1) لقطة قبل
  console.log("\n📸 لقطة قبل الترقية...");
  const before = await snap(ethers.provider);
  console.log(JSON.stringify(before, null, 2));

  // 2) نشر implementation جديد
  console.log("\n⏳ نشر implementation (Build 17)...");
  const Factory = await ethers.getContractFactory("MurabahaV6");
  const impl = await Factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("✅ Implementation:", implAddr);

  // 3) ترقية الـ Proxy
  console.log("\n⏳ upgradeToAndCall...");
  const proxy = new ethers.Contract(PROXY, [
    "function upgradeToAndCall(address,bytes) payable",
  ], deployer);
  const tx = await proxy.upgradeToAndCall(implAddr, "0x");
  console.log("TX:", tx.hash);
  await tx.wait();
  console.log("✅ تمت الترقية");

  // 4) لقطة بعد + مقارنة
  console.log("\n📸 لقطة بعد الترقية...");
  const after = await snap(ethers.provider);
  const checks: [string, boolean][] = [
    ["owner ثابت", before.owner === after.owner],
    ["nextOfferId ثابت", before.nextOfferId === after.nextOfferId],
    ["nextPositionId ثابت", before.nextPositionId === after.nextPositionId],
    ["protocolFeeBps ثابت", before.protocolFeeBps === after.protocolFeeBps],
    ["brokerageFeeBps ثابت", before.brokerageFeeBps === after.brokerageFeeBps],
    ["offer #13 seller سليم", before.o13_seller === after.o13_seller],
    ["offer #13 profitBps سليم", before.o13_profitBps === after.o13_profitBps],
    ["position #8 buyer سليم", before.p8_buyer === after.p8_buyer],
    ["position #8 totalPayable سليم", before.p8_totalPayable === after.p8_totalPayable],
    ["position #8 state سليم", before.p8_state === after.p8_state],
  ];
  console.log("\n═══ سلامة البيانات بعد الترقية ═══");
  let allPass = true;
  for (const [n, ok] of checks) { console.log(`  ${ok ? "✅" : "🔴"} ${n}`); if (!ok) allPass = false; }

  // القيم الجديدة
  const c17 = new ethers.Contract(PROXY, [
    "function GRACE_PERIOD() view returns (uint256)",
    "function MAX_PROFIT_BPS() view returns (uint16)",
    "function activePositionsCount() view returns (uint256)",
    "function sequencerUptimeFeed() view returns (address)",
  ], ethers.provider);
  const grace = (await c17.GRACE_PERIOD()).toString();
  const maxProfit = (await c17.MAX_PROFIT_BPS()).toString();
  const activeCount = (await c17.activePositionsCount()).toString();
  console.log("\n═══ القيم الجديدة (Build 17) ═══");
  console.log(`  GRACE_PERIOD         = ${grace} ${grace === "259200" ? "✅" : "🔴"}`);
  console.log(`  MAX_PROFIT_BPS       = ${maxProfit} ${maxProfit === "30000" ? "✅" : "🔴"}`);
  console.log(`  activePositionsCount = ${activeCount} ${activeCount === "0" ? "✅" : "🔴"}`);

  if (!allPass || grace !== "259200" || maxProfit !== "30000") {
    console.log("\n🔴 توقّف — فشل تحقّق. راجع قبل أي خطوة أخرى.");
    console.log("Implementation الجديد:", implAddr);
    return;
  }

  // 5) تفعيل H2
  console.log("\n⏳ تفعيل H2: setSequencerUptimeFeed...");
  const proxyOwner = new ethers.Contract(PROXY, [
    "function setSequencerUptimeFeed(address)",
  ], deployer);
  const tx2 = await proxyOwner.setSequencerUptimeFeed(BASE_SEQUENCER_FEED);
  console.log("TX:", tx2.hash);
  await tx2.wait();
  const seqAfter = await c17.sequencerUptimeFeed();
  console.log(`✅ sequencerUptimeFeed = ${seqAfter} ${seqAfter.toLowerCase() === BASE_SEQUENCER_FEED.toLowerCase() ? "✅" : "🔴"}`);

  console.log("\n🎉 نشر Build 17 ناجح وكامل!");
  console.log("════════════════════════════════════════");
  console.log("Implementation الجديد:", implAddr);
  console.log("Proxy (ثابت):", PROXY);
  console.log("════════════════════════════════════════");
  console.log("\n📝 حدّث Implementation address في:");
  console.log("  - CLAUDE.md (العقد + المركزي)");
  console.log("  - ذاكرة المشروع/project_state.md");
}

main().catch((e) => { console.error(e); process.exit(1); });

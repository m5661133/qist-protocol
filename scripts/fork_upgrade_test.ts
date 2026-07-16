/**
 * fork_upgrade_test — يحاكي ترقية Build 16 (الحيّ) → Build 17 على Base fork.
 * يتأكد أن:
 *  1. البيانات القديمة (positions/offers/owner/nextIds) تبقى سليمة بعد الترقية (لا تلف storage)
 *  2. القيم الجديدة (GRACE=259200, MAX_PROFIT=30000, sequencerUptimeFeed=0, activePositionsCount=0) صحيحة
 *
 * يُشغَّل على fork محلي:
 *   npx hardhat run scripts/fork_upgrade_test.ts
 * (hardhat.config يجب أن يحوي forking للـ base — يُفعَّل عبر متغير FORK=1)
 */
import { ethers, network, upgrades } from "hardhat";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const OWNER = "0xef6F0C01C1f61a798923Baf57eb515f45d68c2e4";

async function readState(label: string) {
  const abi = [
    "function owner() view returns (address)",
    "function nextOfferId() view returns (uint256)",
    "function nextPositionId() view returns (uint256)",
    "function protocolFeeBps() view returns (uint16)",
    "function brokerageFeeBps() view returns (uint16)",
    "function getOffer(uint256) view returns (tuple(address seller,address saleToken,address collateralToken,address paymentToken,uint256 totalAmount,uint256 saleAmount,uint256 minPurchaseAmount,uint16 profitBps,uint8 minInstallments,uint8 maxInstallments,uint32 paymentInterval,uint16 collateralRatioBps,uint8 state,bool autoLiquidateEnabled))",
    "function getPosition(uint256) view returns (tuple(uint256 offerId,address buyer,address saleToken,address collateralToken,address paymentToken,uint256 saleAmount,uint256 collateralAmount,uint256 totalPayable,uint8 totalInstallments,uint8 paidInstallments,uint32 paymentInterval,uint256 nextDueDate,uint8 state,bool autoPayEnabled))",
  ];
  const c = new ethers.Contract(PROXY, abi, ethers.provider);
  const offer13 = await c.getOffer(13).catch(() => null);
  const pos8 = await c.getPosition(8).catch(() => null);
  const s = {
    owner: await c.owner(),
    nextOfferId: (await c.nextOfferId()).toString(),
    nextPositionId: (await c.nextPositionId()).toString(),
    protocolFeeBps: (await c.protocolFeeBps()).toString(),
    brokerageFeeBps: (await c.brokerageFeeBps()).toString(),
    offer13_seller: offer13 ? offer13.seller : "—",
    offer13_profitBps: offer13 ? offer13.profitBps.toString() : "—",
    pos8_buyer: pos8 ? pos8.buyer : "—",
    pos8_totalPayable: pos8 ? pos8.totalPayable.toString() : "—",
    pos8_state: pos8 ? pos8.state.toString() : "—",
  };
  console.log(`\n── ${label} ──`);
  for (const [k, v] of Object.entries(s)) console.log(`  ${k.padEnd(20)} = ${v}`);
  return s;
}

async function main() {
  console.log("🔱 Fork Upgrade Test: Build 16 (حيّ) → Build 17\n");

  // الحالة قبل الترقية
  const before = await readState("قبل الترقية (Build 16 الحيّ)");

  // impersonate المالك
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [OWNER] });
  await network.provider.send("hardhat_setBalance", [OWNER, "0x56BC75E2D63100000"]); // 100 ETH للـ gas
  const owner = await ethers.getSigner(OWNER);

  // نشر Build 17 implementation + ترقية الـ Proxy
  console.log("\n⏳ نشر Build 17 وترقية الـ Proxy (على الـ fork)...");
  const Factory = await ethers.getContractFactory("MurabahaV6", owner);
  const newImpl = await Factory.deploy();
  await newImpl.waitForDeployment();
  const newImplAddr = await newImpl.getAddress();

  const proxy = new ethers.Contract(PROXY, [
    "function upgradeToAndCall(address,bytes) payable",
  ], owner);
  const tx = await proxy.upgradeToAndCall(newImplAddr, "0x");
  await tx.wait();
  console.log("✅ تمت الترقية على الـ fork. Impl:", newImplAddr);

  // الحالة بعد الترقية — يجب أن تطابق القديمة
  const after = await readState("بعد الترقية (Build 17)");

  // القيم الجديدة
  const c17 = new ethers.Contract(PROXY, [
    "function GRACE_PERIOD() view returns (uint256)",
    "function MAX_PROFIT_BPS() view returns (uint16)",
    "function sequencerUptimeFeed() view returns (address)",
    "function activePositionsCount() view returns (uint256)",
  ], ethers.provider);
  console.log("\n── القيم الجديدة (Build 17) ──");
  console.log("  GRACE_PERIOD         =", (await c17.GRACE_PERIOD()).toString(), "(متوقّع 259200)");
  console.log("  MAX_PROFIT_BPS       =", (await c17.MAX_PROFIT_BPS()).toString(), "(متوقّع 30000)");
  console.log("  sequencerUptimeFeed  =", await c17.sequencerUptimeFeed(), "(متوقّع 0x0 — يُضبط بعد النشر)");
  console.log("  activePositionsCount =", (await c17.activePositionsCount()).toString(), "(متوقّع 0)");

  // التحقق من سلامة البيانات
  console.log("\n═══ الحكم ═══");
  const checks = [
    ["owner ثابت", before.owner === after.owner],
    ["nextOfferId ثابت", before.nextOfferId === after.nextOfferId],
    ["nextPositionId ثابت", before.nextPositionId === after.nextPositionId],
    ["protocolFeeBps ثابت", before.protocolFeeBps === after.protocolFeeBps],
    ["offer #13 seller سليم", before.offer13_seller === after.offer13_seller],
    ["offer #13 profitBps سليم", before.offer13_profitBps === after.offer13_profitBps],
    ["position #8 buyer سليم", before.pos8_buyer === after.pos8_buyer],
    ["position #8 totalPayable سليم", before.pos8_totalPayable === after.pos8_totalPayable],
    ["position #8 state سليم", before.pos8_state === after.pos8_state],
    ["GRACE = 259200", (await c17.GRACE_PERIOD()).toString() === "259200"],
    ["MAX_PROFIT = 30000", (await c17.MAX_PROFIT_BPS()).toString() === "30000"],
    ["activePositionsCount = 0", (await c17.activePositionsCount()).toString() === "0"],
  ];
  let allPass = true;
  for (const [name, ok] of checks) { console.log(`  ${ok ? "✅" : "🔴"} ${name}`); if (!ok) allPass = false; }
  console.log(allPass ? "\n✅ كل الفحوصات نجحت — الترقية لا تُتلف الـ storage." : "\n🔴 فشل — لا تنشر!");
}

main().catch((e) => { console.error(e); process.exit(1); });

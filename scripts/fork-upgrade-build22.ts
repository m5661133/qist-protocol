/**
 * fork-upgrade-build22 — محاكاة ترقية Build 21 (الحي) → Build 22 على نسخة محلية من Base.
 *
 *   FORK_BLOCK=<كتلة> npx hardhat --config hardhat.fork.config.ts run scripts/fork-upgrade-build22.ts
 *
 * لا يرسل أي معاملة إلى Base: كل شيء على شبكة hardhat المحلية (chainId 31337) المتفرّعة.
 * يتحقق من:
 *   1. مصدر legacy/b21 يطابق التنفيذ الحي، وتوافق التخزين ضد Build 21 الفعلي.
 *   2. المكتبات الأربع والتنفيذ: كود منشور = مُجمَّع محلياً، وكل منها ≤ 24,576.
 *   3. الترقية الذرّية من الـSafe: upgradeToAndCall(impl, initializeV3(20k,15k,5k)).
 *   4. كل العروض والمراكز والإعدادات والأرصدة كما هي بعد الترقية.
 *   5. عدّادات العهدة = إعادة حسابها مستقلاً من العروض والمراكز الحية، والرصيد ≥ المستحق.
 *   6. initializeV3 لا تُستدعى ثانيةً، ومعاملة ترقية بحدود متناقضة تُرفض كاملة.
 *   7. السقف يعمل على الحالة الحية: عرض صغير يمر، عرض فوق حد العروض يُرفض.
 *   8. الرجوع إلى Build 21 ثم العودة إلى Build 22 دون فقد بيانات.
 */
import { ethers, network } from "hardhat";
import { PROXY, BUILD21_IMPL, BUILD21_CODEHASH, CAPS, LIBS, IMPL_SLOT, preflight, deployBuild22, validateAgainstBuild21, upgradeCalldata } from "./build22-upgrade";
import { planReconciliation, healthOf } from "./custody-reconcile";

const INIT_SLOT = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ETH = ethers.ZeroAddress;
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";

const READ_ABI = [
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function nextOfferId() view returns (uint256)",
  "function nextPositionId() view returns (uint256)",
  "function protocolFeeBps() view returns (uint16)",
  "function brokerageFeeBps() view returns (uint16)",
  "function protocolTreasury() view returns (address)",
  "function maxPositionValueUSDC() view returns (uint256)",
  "function maxActivePositions() view returns (uint256)",
  "function totalPendingETH() view returns (uint256)",
  "function sequencerUptimeFeed() view returns (address)",
  "function getSupportedTokens() view returns (address[])",
  "function tokenConfigs(address) view returns (address priceFeed, uint8 decimals, bool isStablecoin, bool active)",
  "function getOffer(uint256) view returns (tuple(address seller,address saleToken,address collateralToken,address paymentToken,uint256 totalAmount,uint256 saleAmount,uint256 minPurchaseAmount,uint16 profitBps,uint8 minInstallments,uint8 maxInstallments,uint32 paymentInterval,uint16 collateralRatioBps,uint8 state,bool autoLiquidateEnabled))",
  "function getPosition(uint256) view returns (tuple(uint256 offerId,address buyer,address saleToken,address collateralToken,address paymentToken,uint256 saleAmount,uint256 collateralAmount,uint256 totalPayable,uint8 totalInstallments,uint8 paidInstallments,uint32 paymentInterval,uint256 nextDueDate,uint8 state,bool autoPayEnabled))",
];
const V22_ABI = [
  "function offerCustody(address) view returns (uint256)",
  "function collateralCustody(address) view returns (uint256)",
  "function globalCapUSDC() view returns (uint256)",
  "function commitmentCapUSDC() view returns (uint256)",
  "function offerCapUSDC() view returns (uint256)",
  "function accountingFault() view returns (bool)",
  "function totalExposureUSDC() view returns (uint256)",
  "function initializeV3(uint256,uint256,uint256)",
  "function upgradeToAndCall(address,bytes) payable",
  "function createOffer(address,address,address,uint256,uint16,uint8,uint8,uint32,uint256,uint16,bool) payable returns (uint256)",
  "function pause()",
  "function unpause()",
  "function reconcileCustody(address[],uint256[],uint256[])",
  "error GlobalCapExceeded(uint256 exposureUSDC, uint256 capUSDC)",
  "error OfferCapExceeded(uint256 offersUSDC, uint256 capUSDC)",
];
const BUILD19_IMPL = "0xB775F07634aD5e673261eD5cE6a03924DC0A0816"; // تنفيذ سابق حقيقي على Base — لاختبار B6-UPG-01

const checks: [string, boolean][] = [];
const ok = (name: string, cond: boolean) => { checks.push([name, cond]); console.log(`  ${cond ? "✅" : "🔴"} ${name}`); };
const j = (x: any) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const implOf = async () => "0x" + (await ethers.provider.getStorage(PROXY, IMPL_SLOT)).slice(-40);
const initVersion = async () => BigInt(await ethers.provider.getStorage(PROXY, INIT_SLOT)) & ((1n << 64n) - 1n);

async function snapshot(c: any) {
  const tokens: string[] = await c.getSupportedTokens();
  const nOff = Number(await c.nextOfferId()), nPos = Number(await c.nextPositionId());
  const offers = [], positions = [], cfgs = [], bals = [];
  for (let i = 1; i < nOff; i++) offers.push((await c.getOffer(i)).toArray());
  for (let i = 1; i < nPos; i++) positions.push((await c.getPosition(i)).toArray());
  for (const t of tokens) {
    cfgs.push((await c.tokenConfigs(t)).toArray());
    bals.push(t === ETH ? await ethers.provider.getBalance(PROXY)
      : await new ethers.Contract(t, ["function balanceOf(address) view returns (uint256)"], ethers.provider).balanceOf(PROXY));
  }
  return {
    owner: await c.owner(), paused: await c.paused(), nOff, nPos,
    fees: [await c.protocolFeeBps(), await c.brokerageFeeBps(), await c.protocolTreasury()],
    launchCaps: [await c.maxPositionValueUSDC(), await c.maxActivePositions()],
    pendingETH: await c.totalPendingETH(), seqFeed: await c.sequencerUptimeFeed(),
    tokens, cfgs, bals, offers, positions,
  };
}

async function main() {
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 31337n) throw new Error("⛔ هذا السكربت للمحاكاة المحلية فقط");
  // الاستدعاءات على كتلة التفرّع نفسها تُعامل كتاريخية؛ كتلة محلية واحدة تجعل «latest» محلية
  await network.provider.send("hardhat_mine", ["0x1"]);
  const blk = await ethers.provider.getBlockNumber();
  console.log(`🔱 محاكاة ترقية Build 21 → Build 22 — نسخة Base عند الكتلة ${blk}\n`);

  const c = new ethers.Contract(PROXY, [...READ_ABI, ...V22_ABI], ethers.provider);
  const SAFE = await c.owner();

  console.log("── 0. B6-UPG-01: Proxy على تنفيذ آخر ⇒ رفض قبل أي نشر أو forceImport");
  {
    const snap = await network.provider.send("evm_snapshot", []);
    await network.provider.send("hardhat_setStorageAt", [PROXY, IMPL_SLOT, ethers.zeroPadValue(BUILD19_IMPL, 32)]);
    const [d] = await ethers.getSigners();
    const nonce0 = await ethers.provider.getTransactionCount(d.address);
    let msg = "";
    try { await preflight(); await deployBuild22(d); } catch (e: any) { msg = e.message; }
    ok(`preflight يرفض: «${msg.slice(0, 60)}…»`, msg.includes("≠ Build 21"));
    ok("لم تُنشر أي مكتبة (nonce المنشئ ثابت)", (await ethers.provider.getTransactionCount(d.address)) === nonce0);
    let msg2 = ""; try { await validateAgainstBuild21(null); } catch (e: any) { msg2 = e.message; }
    ok("validateAgainstBuild21 يرفض قبل forceImport", msg2.includes("≠ Build 21"));
    await network.provider.send("evm_revert", [snap]);
  }

  console.log("\n── 1. خط الأساس الحي");
  const pf = await preflight();
  ok(`preflight: Build 21 (${BUILD21_IMPL.slice(0, 10)}…) · بصمة مطابقة · تهيئة 1 · المالك = الـSafe`,
    pf.impl === BUILD21_IMPL && pf.hash === BUILD21_CODEHASH && pf.ver === 1n);
  const before = await snapshot(c);
  console.log(`     المالك ${SAFE} · عروض ${before.nOff - 1} · مراكز ${before.nPos - 1} · رموز ${before.tokens.length}`);

  console.log("\n── 2. النشر والتحقق من الكود (على النسخة المحلية)");
  const [deployer] = await ethers.getSigners();
  const { libs, implAddr, sizes, Factory } = await deployBuild22(deployer);
  for (const L of [...LIBS, "MurabahaV6"]) console.log(`     ${L.padEnd(16)} ${String(sizes[L]).padStart(6)} بايت  ${L === "MurabahaV6" ? implAddr : libs[L]}`);
  ok("كود المكتبات الأربع والتنفيذ = المُجمَّع محلياً، وكلها ≤ 24,576", true);
  await validateAgainstBuild21(Factory);
  ok("مصدر legacy/b21 = التنفيذ الحي (الكود التنفيذي، بلا ذيل metadata)، وvalidateUpgrade ضد Build 21 نجح", true);

  await network.provider.request({ method: "hardhat_impersonateAccount", params: [SAFE] });
  await network.provider.send("hardhat_setBalance", [SAFE, "0x56BC75E2D63100000"]);
  const safe = await ethers.getSigner(SAFE);

  console.log("\n── 3. الذرّية: ترقية بحدود متناقضة تُرفض كاملة");
  const bad = upgradeCalldata(implAddr, { global: CAPS.global, commitment: CAPS.global + 1n, offer: CAPS.offer });
  let reverted = false;
  try { await (await safe.sendTransaction({ to: PROXY, data: bad })).wait(); } catch { reverted = true; }
  ok("upgradeToAndCall مع initializeV3(20k, 20k+1, 5k) رُفضت", reverted);
  ok("التنفيذ ما زال Build 21 ونسخة التهيئة 1", (await implOf()) === BUILD21_IMPL && (await initVersion()) === 1n);

  console.log("\n── 4. الترقية الفعلية من الـSafe");
  const data = upgradeCalldata(implAddr);
  const rc = await (await safe.sendTransaction({ to: PROXY, data })).wait();
  console.log(`     الغاز ${rc!.gasUsed} · Data ${data.slice(0, 10)}… (${(data.length - 2) / 2} بايت)`);
  ok("التنفيذ = Build 22 الجديد", (await implOf()) === implAddr.toLowerCase());
  ok("نسخة التهيئة = 3", (await initVersion()) === 3n);

  console.log("\n── 5. سلامة البيانات");
  const after = await snapshot(c);
  for (const k of Object.keys(before) as (keyof typeof before)[]) ok(`${k} لم يتغيّر`, j(before[k]) === j(after[k]));

  console.log("\n── 6. ترحيل العهدة — إعادة حساب مستقلة");
  const expOffer: Record<string, bigint> = {}, expCol: Record<string, bigint> = {};
  for (const o of after.offers) if (Number(o[12]) === 0) expOffer[o[1]] = (expOffer[o[1]] ?? 0n) + o[5];
  for (const p of after.positions) if (Number(p[12]) === 0) expCol[p[3]] = (expCol[p[3]] ?? 0n) + p[6];
  for (const [i, t] of after.tokens.entries()) {
    const oc = await c.offerCustody(t), cc = await c.collateralCustody(t);
    const owed = oc + cc + (t === ETH ? after.pendingETH : 0n);
    ok(`${t.slice(0, 8)}… عروض ${oc} = ${expOffer[t] ?? 0n} · ضمان ${cc} = ${expCol[t] ?? 0n} · الرصيد ${after.bals[i]} ≥ ${owed}`,
      oc === (expOffer[t] ?? 0n) && cc === (expCol[t] ?? 0n) && after.bals[i] >= owed);
  }
  ok("الحدود = 20,000 / 15,000 / 5,000", (await c.globalCapUSDC()) === CAPS.global
    && (await c.commitmentCapUSDC()) === CAPS.commitment && (await c.offerCapUSDC()) === CAPS.offer);
  ok("accountingFault = false", (await c.accountingFault()) === false);
  const exposure = await c.totalExposureUSDC();
  console.log(`     إجمالي العهدة الآن $${ethers.formatUnits(exposure, 6)}`);

  console.log("\n── 7. حماية التهيئة");
  let r2 = false; try { await (c.connect(safe) as any).initializeV3.staticCall(CAPS.global, CAPS.commitment, CAPS.offer); } catch { r2 = true; }
  ok("initializeV3 ثانيةً من الـSafe تُرفض", r2);

  console.log("\n── 8. السقف على الحالة الحية");
  const seller = (await ethers.getSigners())[1];
  const offer = (amt: bigint) => (c.connect(seller) as any).createOffer(
    ETH, CBBTC, USDC, amt, 1000, 1, 3, 30 * 86400, amt / 10n, 15000, false, { value: amt });
  const exp0: bigint = await c.totalExposureUSDC();
  let small = true; try { await (await offer(ethers.parseEther("0.01"))).wait(); } catch (e: any) { small = false; console.log("     ", e.shortMessage ?? e.message); }
  ok("عرض صغير 0.01 ETH يمر", small);
  // سعر ETH من فرق العهدة ⇒ عرض بقيمة ≈ $10,000: فوق حد العروض (5k) وتحت حد الالتزامات (15k)
  const usdPerCentiEth: bigint = (await c.totalExposureUSDC()) - exp0;
  const midAmt = (10_000n * 10n ** 6n * ethers.parseEther("0.01")) / usdPerCentiEth;
  console.log(`      سعر ETH ≈ $${ethers.formatUnits(usdPerCentiEth * 100n, 6)} ⇒ عرض ${ethers.formatEther(midAmt)} ETH ≈ $10,000`);
  let midErr = "";
  try {
    await (c.connect(seller) as any).createOffer.staticCall(ETH, CBBTC, USDC, midAmt, 1000, 1, 3, 30 * 86400, midAmt / 10n, 15000, false, { value: midAmt });
  } catch (e: any) { midErr = e.data ?? e.message; }
  ok("عرض ≈ $10,000 يُرفض بحد العروض OfferCapExceeded (5,000)",
    String(midErr).startsWith(ethers.id("OfferCapExceeded(uint256,uint256)").slice(0, 10)));
  // B6-UPG-02: حالتان منفصلتان بفكّ وسيط الحد — الصارم يُفحص أولاً، فحالة 15k يجب أن تبقى تحته
  const iface = new ethers.Interface(V22_ABI);
  const capOf = async (targetUSD: bigint) => {
    const now: bigint = await c.totalExposureUSDC();
    const amt = ((targetUSD * 10n ** 6n - now) * ethers.parseEther("0.01")) / usdPerCentiEth;
    try {
      await (c.connect(seller) as any).createOffer.staticCall(ETH, CBBTC, USDC, amt, 1000, 1, 3, 30 * 86400, amt / 10n, 15000, false, { value: amt });
      return { name: "لا رفض", cap: 0n, exp: 0n };
    } catch (e: any) {
      const d = iface.parseError(e.data);
      return { name: d?.name ?? "?", exp: d ? (d.args[0] as bigint) : 0n, cap: d ? (d.args[1] as bigint) : 0n };
    }
  };
  const r17 = await capOf(17_500n);
  console.log(`      ≈$17,500 ⇒ ${r17.name}(exposure $${ethers.formatUnits(r17.exp, 6)}, cap $${ethers.formatUnits(r17.cap, 6)})`);
  ok("إجمالي ≈$17,500 (بين 15k و20k) ⇒ GlobalCapExceeded بحد الالتزامات 15,000",
    r17.name === "GlobalCapExceeded" && r17.cap === CAPS.commitment && r17.exp > CAPS.commitment && r17.exp <= CAPS.global);
  const r25 = await capOf(25_000n);
  console.log(`      ≈$25,000 ⇒ ${r25.name}(exposure $${ethers.formatUnits(r25.exp, 6)}, cap $${ethers.formatUnits(r25.cap, 6)})`);
  ok("إجمالي ≈$25,000 (فوق 20k) ⇒ GlobalCapExceeded بالحد الصارم 20,000",
    r25.name === "GlobalCapExceeded" && r25.cap === CAPS.global && r25.exp > CAPS.global);

  console.log("\n── 9. الرجوع إلى Build 21 + نشاط أثناءه + عودة مع الإيقاف + مصالحة");
  const up = (impl: string) => new ethers.Interface(["function upgradeToAndCall(address,bytes)"]).encodeFunctionData("upgradeToAndCall", [impl, "0x"]);
  const mid = await snapshot(c);
  await (await safe.sendTransaction({ to: PROXY, data: up(BUILD21_IMPL) })).wait();
  ok("الرجوع: التنفيذ = Build 21", (await implOf()) === BUILD21_IMPL);
  ok("الرجوع: كل البيانات كما هي", j(mid) === j(await snapshot(c)));
  // نشاط على Build 21: عرض جديد 0.02 ETH — Build 21 لا يعرف العدّادات فلا يحدّثها
  const during = ethers.parseEther("0.02");
  await (await (c.connect(seller) as any).createOffer(ETH, CBBTC, USDC, during, 1000, 1, 3, 30 * 86400, during / 10n, 15000, false, { value: during })).wait();
  // إجراء العودة: إيقاف (على Build 21) ⇒ ترقية بلا تهيئة ⇒ مصالحة ⇒ فتح
  await (await (c.connect(safe) as any).pause()).wait();
  await (await safe.sendTransaction({ to: PROXY, data: up(implAddr) })).wait();
  ok("العودة: Build 22 · تهيئة 3 · الحدود محفوظة · موقوف",
    (await implOf()) === implAddr.toLowerCase() && (await initVersion()) === 3n && (await c.globalCapUSDC()) === CAPS.global && (await c.paused()));
  // scripts/reconcile-custody.ts (نواته) — نفس المسار الذي يوقّعه الـSafe فعلياً
  const before9 = await planReconciliation(ethers.provider, PROXY, { expectedOwner: SAFE });
  const r = before9.rows.find((x) => x.token === ETH)!;
  ok(`قبل المصالحة: check يكشف الانحراف — عدّاد عروض ETH ${ethers.formatEther(r.counterOffer)} ≠ الفعلي ${ethers.formatEther(r.offer)}`,
    !healthOf(before9).ok && r.offer - r.counterOffer === during);
  ok("plan: لا موانع، والمحاكاة من الـSafe نجحت", before9.blockers.length === 0 && !!before9.data);
  let partial = false;
  try { await (c.connect(safe) as any).reconcileCustody.staticCall([ETH], [r.offer], [0n]); } catch { partial = true; }
  ok("reconcileCustody ترفض لقطة ناقصة", partial);
  const verify = await planReconciliation(ethers.provider, PROXY, { expectedOwner: SAFE });
  ok("verify قبل التنفيذ: البصمة لم تتغيّر", verify.dataHash === before9.dataHash);
  await (await safe.sendTransaction({ to: PROXY, data: before9.data! })).wait();
  const after9 = await planReconciliation(ethers.provider, PROXY, { expectedOwner: SAFE });
  ok("بعد المصالحة: check نظيف لكل رمز وaccountingFault = false", healthOf(after9).ok);
  await (await (c.connect(safe) as any).unpause()).wait();
  let resumed = true; try { await (await offer(ethers.parseEther("0.01"))).wait(); } catch { resumed = false; }
  ok("بعد الفتح: إيداع جديد يمر والعدّاد يتابعه (check نظيف)",
    resumed && healthOf(await planReconciliation(ethers.provider, PROXY)).ok);

  const failed = checks.filter(([, v]) => !v);
  console.log(`\n═══ ${checks.length - failed.length}/${checks.length} ═══`);
  console.log(failed.length ? "🔴 فشل — لا ترقية" : "✅ المحاكاة نجحت كاملة");
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

import { ethers } from "ethers";

/**
 * نواة مصالحة العهدة — Build 22، ومنذ Build 23 تضمّ المعلّق ERC20 (docs/global-cap-design.md §4.1).
 * مستقلة عن hre: تأخذ provider وعنوان الـProxy، فتُختبر محلياً وتُشغَّل على Base بلا فرق.
 *
 * تحسب القيم الصحيحة من الحالة نفسها عند كتلة مثبّتة (نفس قاعدة CustodyLib.migrate):
 *   الدلو A = مجموع saleAmount للعروض النشطة لكل رمز · الدلو B = مجموع ضمان المراكز النشطة.
 * ثم تفحص شروط reconcileCustody على السلسلة قبل أي توقيع: الإيقاف، المالك، I2 لكل رمز،
 * ومحاكاة الاستدعاء من المالك عند الكتلة نفسها. لا تُخرج calldata ما لم تتحقق كلها.
 *
 * ⚠️ الإيقاف لا يجمّد كل شيء: cancelOffer/decreaseOffer/withdrawETH تبقى مفتوحة (خروج المستخدم).
 *    خروج بعد اللقطة يجعل القيمة المحسوبة **أكبر** من الحقيقة. I2 على السلسلة ترفض المعاملة إن
 *    هبط الرصيد تحتها، لكنها **تمرّ** إن غطّاها فائض (تبرّع) فيتضخّم العدّاد ويُكسر I1
 *    (test/ReconcileCustody.script.test.ts). لذلك يعيد آخر موقّع الحساب بوضع verify قبل التنفيذ.
 */

export const RECONCILE_ABI = [
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function accountingFault() view returns (bool)",
  "function totalPendingETH() view returns (uint256)",
  "function getSupportedTokens() view returns (address[])",
  "function nextOfferId() view returns (uint256)",
  "function nextPositionId() view returns (uint256)",
  "function offerCustody(address) view returns (uint256)",
  "function collateralCustody(address) view returns (uint256)",
  "function getOffer(uint256) view returns (tuple(address seller,address saleToken,address collateralToken,address paymentToken,uint256 totalAmount,uint256 saleAmount,uint256 minPurchaseAmount,uint16 profitBps,uint8 minInstallments,uint8 maxInstallments,uint32 paymentInterval,uint16 collateralRatioBps,uint8 state,bool autoLiquidateEnabled))",
  "function getPosition(uint256) view returns (tuple(uint256 offerId,address buyer,address saleToken,address collateralToken,address paymentToken,uint256 saleAmount,uint256 collateralAmount,uint256 totalPayable,uint8 totalInstallments,uint8 paidInstallments,uint32 paymentInterval,uint256 nextDueDate,uint8 state,bool autoPayEnabled))",
  "function reconcileCustody(address[] tokens, uint256[] offerValues, uint256[] collateralValues)",
  "error InvalidParams()",
  "error ExpectedPause()",
  "error CustodyInsolvent(address token, uint256 balance, uint256 owed)",
  "error OwnableUnauthorizedAccount(address account)",
];

export type Row = {
  token: string;
  counterOffer: bigint; counterCollateral: bigint;   // العدّادات الحالية على السلسلة
  offer: bigint; collateral: bigint;                 // الصحيحة من الحالة
  pendingETH: bigint; balance: bigint; owed: bigint; // owed = offer + collateral + المعلّق (pendingETH لـETH، totalPendingToken لغيره)
  surplus: bigint;                                   // الرصيد − المستحق (تبرعات/فائض)؛ سالب = عجز
};

export type Blocker = "WRONG_CHAIN" | "NOT_PAUSED" | "OWNER_MISMATCH" | "INSOLVENT" | "SIMULATION_REVERTED";

/** الشبكات المسموحة: Base للإنتاج، وhardhat (31337) للاختبار والنسخ المتفرّعة */
export const ALLOWED_CHAINS = [8453n, 31337n];

export type Plan = {
  chainId: bigint; block: number; proxy: string; owner: string;
  paused: boolean; accountingFault: boolean;
  rows: Row[];
  changes: number;          // عدد الرموز التي يتغيّر عدّادها
  blockers: { code: Blocker; detail: string }[];
  data: string | null;      // calldata reconcileCustody — فقط إن لم يوجد مانع
  value: bigint;            // دائماً 0
  fingerprint: string | null; // B6-REC-02: بصمة المعاملة كاملة (chainId + proxy + value + data)
};

/**
 * بصمة معاملة الـSafe: keccak256(abi.encode(chainId, to, value, data)).
 * B6-REC-02: نفس الأرقام على شبكة أخرى أو Proxy آخر تعطي بصمة مختلفة — تربط التحقق بالمعاملة المقصودة.
 */
export function txFingerprint(t: { chainId: bigint; to: string; value: bigint; data: string }) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "address", "uint256", "bytes"], [t.chainId, t.to, t.value, t.data]));
}

const ETH = ethers.ZeroAddress;

/** Build 23: totalPendingToken (mapping internal، الخانة 30 — forge inspect). قبل Build 23 الخانة صفر فالقراءة 0. */
export const TOTAL_PENDING_TOKEN_SLOT = 30n;
export async function totalPendingToken(provider: ethers.Provider, proxy: string, token: string, blockTag?: number) {
  const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [token, TOTAL_PENDING_TOKEN_SLOT]));
  return BigInt(await provider.getStorage(proxy, slot, blockTag));
}

export function reconcileCalldata(rows: Pick<Row, "token" | "offer" | "collateral">[]) {
  return new ethers.Interface(RECONCILE_ABI).encodeFunctionData("reconcileCustody", [
    rows.map((r) => r.token), rows.map((r) => r.offer), rows.map((r) => r.collateral),
  ]);
}

export async function planReconciliation(
  provider: ethers.Provider,
  proxy: string,
  opts: { blockTag?: number; expectedOwner?: string } = {},
): Promise<Plan> {
  const block = opts.blockTag ?? (await provider.getBlockNumber());
  const o = { blockTag: block };
  const c = new ethers.Contract(proxy, RECONCILE_ABI, provider);
  const iface = c.interface;

  const [owner, paused, fault, pending, tokensR, nOff, nPos] = await Promise.all([
    c.owner(o), c.paused(o), c.accountingFault(o), c.totalPendingETH(o),
    c.getSupportedTokens(o), c.nextOfferId(o), c.nextPositionId(o),
  ]);
  const tokens: string[] = [...tokensR];
  const offer = new Map<string, bigint>(tokens.map((t) => [t, 0n]));
  const col = new Map<string, bigint>(tokens.map((t) => [t, 0n]));
  for (let i = 1n; i < nOff; i++) {
    const x = await c.getOffer(i, o);
    if (Number(x.state) === 0) offer.set(x.saleToken, (offer.get(x.saleToken) ?? 0n) + x.saleAmount);
  }
  for (let i = 1n; i < nPos; i++) {
    const x = await c.getPosition(i, o);
    if (Number(x.state) === 0) col.set(x.collateralToken, (col.get(x.collateralToken) ?? 0n) + x.collateralAmount);
  }

  const erc20 = (t: string) => new ethers.Contract(t, ["function balanceOf(address) view returns (uint256)"], provider);
  const rows: Row[] = [];
  for (const t of tokens) {
    const balance: bigint = t === ETH ? await provider.getBalance(proxy, block) : await erc20(t).balanceOf(proxy, o);
    const p = t === ETH ? (pending as bigint) : await totalPendingToken(provider, proxy, t, block);
    const owed = offer.get(t)! + col.get(t)! + p;
    rows.push({
      token: t,
      counterOffer: await c.offerCustody(t, o), counterCollateral: await c.collateralCustody(t, o),
      offer: offer.get(t)!, collateral: col.get(t)!,
      pendingETH: p, balance, owed, surplus: balance - owed,
    });
  }
  // رمز في عرض/مركز نشط وليس في tokenList = خلل بنيوي (لا يُفترض حدوثه)
  for (const t of [...offer.keys(), ...col.keys()])
    if (!tokens.includes(t)) throw new Error(`⛔ رمز ${t} في عرض/مركز نشط وغير موجود في tokenList`);

  const blockers: Plan["blockers"] = [];
  const chainId = (await provider.getNetwork()).chainId;
  if (!ALLOWED_CHAINS.includes(chainId)) blockers.push({ code: "WRONG_CHAIN", detail: `chainId ${chainId} غير مسموح` });
  if (!paused) blockers.push({ code: "NOT_PAUSED", detail: "العقد غير موقوف — reconcileCustody تتطلب whenPaused، واللقطة لا تُعتمد قبل الإيقاف" });
  if (opts.expectedOwner && owner.toLowerCase() !== opts.expectedOwner.toLowerCase())
    blockers.push({ code: "OWNER_MISMATCH", detail: `المالك ${owner} ≠ المتوقع ${opts.expectedOwner}` });
  for (const r of rows)
    if (r.surplus < 0n) blockers.push({ code: "INSOLVENT", detail: `${r.token}: الرصيد ${r.balance} < المستحق ${r.owed} — عجز فعلي، لا مصالحة بل تحقيق` });

  const changes = rows.filter((r) => r.counterOffer !== r.offer || r.counterCollateral !== r.collateral).length;
  let data: string | null = reconcileCalldata(rows);
  if (!blockers.length) {
    try {
      await provider.call({ from: owner, to: proxy, data, blockTag: block });
    } catch (e: any) {
      const raw = e?.data ?? e?.info?.error?.data;
      let why = e?.shortMessage ?? e?.message ?? String(e);
      try { const p = iface.parseError(raw); if (p) why = `${p.name}(${p.args.join(", ")})`; } catch { /* نص الخطأ */ }
      blockers.push({ code: "SIMULATION_REVERTED", detail: why });
    }
  }
  if (blockers.length) data = null;

  return {
    chainId, block, proxy, owner, paused, accountingFault: fault,
    rows, changes, blockers, data, value: 0n,
    fingerprint: data ? txFingerprint({ chainId, to: proxy, value: 0n, data }) : null,
  };
}

/**
 * B6-REC-01: التحقق قبل التنفيذ — على **أحدث كتلة دائماً**. أي كتلة مثبّتة تُرفض، لأن إعادة
 * لقطة plan نفسها تعطي البصمة نفسها مهما تغيّرت الحالة بعدها.
 * ⚠️ النجاح لا يقفل الحالة حتى التنفيذ (المخارج مفتوحة أثناء الإيقاف) — check بعد التنفيذ إلزامي.
 */
export async function verifyPlan(
  provider: ethers.Provider, proxy: string, expected: string,
  opts: { blockTag?: number; expectedOwner?: string } = {},
) {
  if (opts.blockTag !== undefined) throw new Error("⛔ verify لا يقبل كتلة مثبّتة — يتحقق من أحدث كتلة فقط");
  const latest = await provider.getBlock("latest");
  const plan = await planReconciliation(provider, proxy, { blockTag: latest!.number, expectedOwner: opts.expectedOwner });
  const match = !!plan.fingerprint && plan.fingerprint === expected.toLowerCase();
  return { match, plan, block: latest!.number, timestamp: latest!.timestamp };
}

/** وضع المراقبة: هل تطابق العدّادات الحالة وI2 سليمة؟ (لا يحتاج إيقافاً) */
export function healthOf(plan: Plan) {
  const drift = plan.rows.filter((r) => r.counterOffer !== r.offer || r.counterCollateral !== r.collateral);
  const insolvent = plan.rows.filter((r) => r.surplus < 0n);
  return { ok: !drift.length && !insolvent.length && !plan.accountingFault, drift, insolvent };
}

/**
 * B6-REC-03: بوابة إعادة الفتح — على **أحدث كتلة فقط** وبشبكة ومالك متوقعين.
 * الفحص التاريخي (BLOCK) للمراجعة وحدها ولا يمنح إذن فتح، لأن لقطة قديمة سليمة لا تقول شيئاً
 * عن الحالة الآن. العقد لا يفرض هذا الفحص قبل unpause — هو إجراء تشغيلي على الموقّعين.
 */
export async function unpauseReadiness(
  provider: ethers.Provider, proxy: string,
  opts: { blockTag?: number; expectedOwner: string },
) {
  if (opts.blockTag !== undefined) throw new Error("⛔ بوابة الفتح لا تقبل كتلة مثبّتة — تفحص أحدث كتلة فقط");
  if (!opts.expectedOwner) throw new Error("⛔ بوابة الفتح تحتاج المالك المتوقع");
  const latest = await provider.getBlock("latest");
  const plan = await planReconciliation(provider, proxy, { blockTag: latest!.number, expectedOwner: opts.expectedOwner });
  return { ...readinessOf(plan), plan, block: latest!.number, timestamp: latest!.timestamp };
}

/** قرار الفتح من لقطة: حسابات سليمة + شبكة ومالك متوقعان + العقد موقوف فعلاً */
export function readinessOf(plan: Plan) {
  const h = healthOf(plan);
  const reasons: string[] = [];
  for (const b of plan.blockers) if (b.code === "WRONG_CHAIN" || b.code === "OWNER_MISMATCH") reasons.push(`${b.code}: ${b.detail}`);
  if (h.drift.length) reasons.push(`انحراف في ${h.drift.length} رمز`);
  if (h.insolvent.length) reasons.push(`عجز في ${h.insolvent.length} رمز`);
  if (plan.accountingFault) reasons.push("accountingFault مرفوع");
  if (!plan.paused) reasons.push("العقد غير موقوف أصلاً");
  return { ready: reasons.length === 0, reasons, health: h };
}


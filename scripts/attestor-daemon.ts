import { ethers } from "hardhat";
import { vaultAddress } from "./lib/vault";

/**
 * attestor دائم: يربط شبكة Bitcoin بعقد BtcEscrowMurabaha على Base.
 *
 *   ATTESTOR_PRIVATE_KEY=… npx hardhat run scripts/attestor-daemon.ts --network base
 *   ONCE=1 …  → دورة واحدة ثم خروج (للفحص)
 *   DRY=1  …  → يرصد ويطبع بلا إرسال أي معاملة
 *
 * ## ما يفعله
 * لكل صفقة نشطة: يقرأ حالتها من العقد، يشتقّ عنوان خزنتها، يستعلم Esplora
 * عن الرصيد/المعاملات، ثم يشهد بما حدث **فعلاً** على Bitcoin.
 *
 * ## ما لا يفعله
 * لا يحمل مفتاح مستخدم، ولا يوقّع معاملة Bitcoin، ولا يحرّك ساتوشي.
 * شهاداته تسجيل فقط — لو زُوّرت، لا يتحرّك بيتكوين حقيقي.
 *
 * ## قواعد سلامة مفروضة
 * - **لا يشهد إلا بمعاملات مؤكّدة** (`MIN_CONF`). المعلّق قد يسقط أو يُستبدل.
 * - **لا يشهد بما شهد به** — يقرأ حالة العقد أولاً ويتجاوز المُنجَز.
 * - يتوقّف عند نفاد الغاز بدل الدوران على أخطاء.
 */

const PROXY = "0x47Ce614E8D1EBd19d66f254c062bDDEA2F3e3103";
const ESPLORA = process.env.ESPLORA ?? "https://mempool.space/api";
const MIN_CONF = Number(process.env.MIN_CONF ?? 1);
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 60_000);
const DRY = process.env.DRY === "1";
const ONCE = process.env.ONCE === "1";

/// مفتاح قسط العام (الحَكَم) — الطرف الثالث في كل خزنة.
const QIST_PUBKEY =
  process.env.QIST_BTC_PUBKEY ??
  "0x039f967798fea0125d24effdad335011445f68da3475284df05d4faf161fed8bfc";

const S = {
  OPEN: 0, AWAITING_COLLATERAL: 1, AWAITING_DELIVERY: 2, ACTIVE: 3,
  PAYMENT_OVERDUE: 4, MARGIN_CALL: 5, DEFAULT_PENDING: 6, DISPUTED: 7,
  LIQUIDATION_ELIGIBLE: 8, LIQUIDATED: 9, REPAID: 10,
  COLLATERAL_RELEASED: 11, CANCELLED: 12,
} as const;
const NAMES = Object.keys(S);

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function esplora(path: string): Promise<any> {
  const r = await fetch(`${ESPLORA}${path}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`Esplora ${r.status} على ${path}`);
  return r.json();
}

/** معاملات العنوان المؤكّدة فقط — المعلّق لا يُشهد به. */
async function confirmedTxs(address: string): Promise<any[]> {
  const txs = (await esplora(`/address/${address}/txs`)) as any[];
  return txs.filter((t) => t?.status?.confirmed === true);
}

/** مجموع ما وصل العنوان من معاملة (بالساتوشي). */
function receivedIn(tx: any, address: string): number {
  return (tx.vout ?? [])
    .filter((o: any) => o.scriptpubkey_address === address)
    .reduce((a: number, o: any) => a + Number(o.value), 0);
}

async function tipHeight(): Promise<number> {
  const r = await fetch(`${ESPLORA}/blocks/tip/height`, {
    signal: AbortSignal.timeout(20_000),
  });
  return Number((await r.text()).trim());
}

async function main() {
  // يفضّل مفتاح attestor مخصّصاً، ويتراجع لمفتاح الناشر إن لم يوجد.
  // ⚠️ الناشر هو **مالك العقد** أيضاً — تشغيله في خدمة دائمة يضع مفتاح
  //    الملكية على عملية تعمل ٢٤/٧. للتحويل لاحقاً: املأ ATTESTOR_PRIVATE_KEY
  //    ونفّذ setAttestor — بلا أي تغيير في هذا الملف.
  const pk = process.env.ATTESTOR_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!pk) throw new Error("لا ATTESTOR_PRIVATE_KEY ولا PRIVATE_KEY في .env");
  const usingOwnerKey = !process.env.ATTESTOR_PRIVATE_KEY;

  const provider = ethers.provider;
  const signer = new ethers.Wallet(pk, provider);
  const m: any = (await ethers.getContractFactory("BtcEscrowMurabaha"))
    .attach(PROXY)
    .connect(signer);

  const onchainAttestor = await m.attestor();
  const bal = await provider.getBalance(signer.address);

  log(`attestor: ${signer.address}`);
  log(`المسجَّل في العقد: ${onchainAttestor}`);
  log(`رصيد الغاز: ${ethers.formatEther(bal)} ETH`);
  log(`الوضع: ${DRY ? "رصد فقط (DRY)" : "شهادة فعلية"} · تأكيدات ≥ ${MIN_CONF}`);
  if (usingOwnerKey) {
    log("⚠️ يعمل بمفتاح الناشر (وهو مالك العقد). للفصل: ATTESTOR_PRIVATE_KEY + setAttestor");
  }

  if (onchainAttestor.toLowerCase() !== signer.address.toLowerCase()) {
    log("⚠️ هذا العنوان ليس الـattestor المسجَّل — الشهادات سترتدّ.");
    log(`   يلزم من المالك: setAttestor(${signer.address})`);
    if (!DRY) throw new Error("توقّف: attestor غير مصرَّح");
  }
  if (bal === 0n && !DRY) throw new Error("توقّف: لا غاز في محفظة الـattestor");

  do {
    try {
      await tick(m);
    } catch (e: any) {
      log(`❌ دورة فشلت: ${e.message ?? e}`);
    }
    if (!ONCE) await new Promise((r) => setTimeout(r, INTERVAL_MS));
  } while (!ONCE);
}

async function tick(m: any) {
  const next = Number(await m.nextDealId());
  if (next <= 1) {
    log("لا صفقات بعد.");
    return;
  }
  const tip = await tipHeight();
  let watched = 0;

  for (let id = 1; id < next; id++) {
    const d = await m.getDeal(id);
    const state = Number(d.state);

    // حالات التعزيز: الصفقة حيّة ويجوز للمشتري رفع الرهن على L1 (BE-14).
    // بلا رصدها يبقى «يمكنك زيادة الضمان» وعداً لا يُنفَّذ: يرسل المشتري
    // بيتكويناً إلى الخزنة فلا يتغيّر شيء على Base ويُصفَّى وهو معزّز فعلاً.
    const TOPUP = [S.ACTIVE, S.PAYMENT_OVERDUE, S.MARGIN_CALL, S.DEFAULT_PENDING];
    // فكّ الرهن: بعد السداد الكامل أو الإلغاء، الطرفان يوقّعان PSBT ويبثّانه
    // على L1 مباشرة (راجع btc_release_psbt_screen.dart) — بلا رصدها هنا تبقى
    // الصفقة REPAID/CANCELLED للأبد على العقد رغم أن الرهن عاد فعلياً
    // (وقع فعلياً مع صفقة #6: بُثّت المعاملة يدوياً ولم يسجّلها العقد وحده).
    const RELEASE_WATCH = [S.REPAID, S.CANCELLED];

    if (
      state !== S.AWAITING_COLLATERAL &&
      state !== S.AWAITING_DELIVERY &&
      !TOPUP.includes(state) &&
      !RELEASE_WATCH.includes(state)
    ) continue;
    watched++;
    if (!d.sellerBtcPubkey || !d.buyerBtcPubkey || d.buyerBtcPubkey === "0x") {
      log(`#${id}: مفاتيح ناقصة — تُخطّى`);
      continue;
    }

    const vault = vaultAddress(d.buyerBtcPubkey, d.sellerBtcPubkey, QIST_PUBKEY);

    if (state === S.AWAITING_COLLATERAL) {
      await handleCollateral(m, id, d, vault, tip);
    } else if (state === S.AWAITING_DELIVERY) {
      await handleDelivery(m, id, d, tip);
    } else if (RELEASE_WATCH.includes(state)) {
      await handleCollateralRelease(m, id, vault, tip);
    } else {
      await handleTopUp(m, id, d, vault, tip);
    }
  }

  // سطر ختامي دائم — صمت الـdaemon يجب ألّا يُخلط بتعطّله
  log(`دورة انتهت · ${next - 1} صفقة · ${watched} تحت المراقبة · كتلة ${tip}`);
}

/**
 * يعكس رصيد الخزنة الفعلي على العقد لصفقة حيّة (BE-14).
 *
 * المشتري يعزّز ضمانه بإرسال بيتكوين إلى الخزنة — ولا أحد يخبر Base بذلك.
 * هنا نقارن الرصيد المؤكَّد بالمسجَّل، وندعو `updateCollateral` عند الاختلاف
 * فيُعاد حساب الحالة الصحية (وقد تخرج الصفقة من MARGIN_CALL من تلقائها).
 *
 * يُرسل عند **أي** اختلاف لا الزيادة فقط: نقصان الرصيد واقعٌ يجب أن يعرفه
 * العقد أيضاً، وإخفاؤه يجعل LTV المعروض كذبة.
 */
async function handleTopUp(m: any, id: number, d: any, vault: string, tip: number) {
  const onChain = BigInt(d.collateralSats);
  const txs = await confirmedTxs(vault);

  let total = 0n;
  let lastTxid = "";
  for (const t of txs) {
    const h = t.status.block_height as number;
    if (tip - h + 1 < MIN_CONF) continue;
    const got = receivedIn(t, vault);
    if (got > 0) {
      total += BigInt(got);
      lastTxid = t.txid;
    }
  }

  if (total === onChain) return; // لا جديد — الصمت هنا صحيح
  log(`#${id} 🔄 الرهن ${onChain} → ${total} ساتوشي — تحديث`);
  if (DRY) return;

  const tx = await m.updateCollateral(id, total, "0x" + (lastTxid || "0".repeat(64)));
  log(`   tx ${tx.hash}`);
  await tx.wait();
}

/** يشهد بإيداع الرهن حين يبلغ المطلوب بتأكيدات كافية. */
async function handleCollateral(m: any, id: number, d: any, vault: string, tip: number) {
  const need = BigInt(d.requiredCollateralSats);
  const txs = await confirmedTxs(vault);

  let total = 0n;
  let lastTxid = "";
  for (const t of txs) {
    const h = t.status.block_height as number;
    if (tip - h + 1 < MIN_CONF) continue; // تأكيدات غير كافية
    const got = receivedIn(t, vault);
    if (got > 0) {
      total += BigInt(got);
      lastTxid = t.txid;
    }
  }

  if (total < need) {
    log(`#${id} رهن: ${total}/${need} ساتوشي — بانتظار المزيد`);
    return;
  }
  log(`#${id} ✅ الرهن مكتمل (${total} ساتوشي) — شهادة`);
  if (DRY) return;

  const descHash = ethers.id(vault); // التزام بوصف الخزنة
  const tx = await m.confirmCollateral(id, total, descHash, "0x" + lastTxid);
  log(`   tx ${tx.hash}`);
  await tx.wait();
}

/** يشهد بتسليم المبيع حين يصل عنوان المشتري بتأكيدات كافية. */
async function handleDelivery(m: any, id: number, d: any, tip: number) {
  const dest = d.buyerBtcAddress as string;
  if (!dest) {
    log(`#${id}: لا عنوان استلام مسجَّل — تُخطّى`);
    return;
  }
  const need = BigInt(d.merchandiseSats);
  const txs = await confirmedTxs(dest);

  for (const t of txs) {
    const h = t.status.block_height as number;
    if (tip - h + 1 < MIN_CONF) continue;
    const got = BigInt(receivedIn(t, dest));
    if (got < need) continue;

    log(`#${id} ✅ وصل المبيع (${got} ساتوشي) — شهادة`);
    if (DRY) return;
    const tx = await m.confirmDelivery(id, got, "0x" + t.txid);
    log(`   tx ${tx.hash}`);
    await tx.wait();
    return;
  }
  log(`#${id} تسليم: لم يصل ${need} ساتوشي بعد إلى ${dest.slice(0, 14)}…`);
}

/**
 * يشهد بأن الرهن فُكّ فعلاً حين يجد معاملة مؤكَّدة **تُنفق** من عنوان الخزنة
 * (لا تستقبل — تُنفق). فكّ الرهن يتم خارج العقد تماماً: الطرفان يوقّعان PSBT
 * ببناء `btc_release_psbt_screen.dart` ويبثّانه مباشرة على L1، فلا حدث Base
 * يخبر العقد — هذا هو الرصد الوحيد الممكن.
 */
async function handleCollateralRelease(m: any, id: number, vault: string, tip: number) {
  const txs = await confirmedTxs(vault);

  for (const t of txs) {
    const h = t.status.block_height as number;
    if (tip - h + 1 < MIN_CONF) continue;
    const spendsVault = (t.vin ?? []).some(
      (i: any) => i?.prevout?.scriptpubkey_address === vault
    );
    if (!spendsVault) continue;

    log(`#${id} ✅ الرهن فُكّ فعلاً على L1 (tx ${t.txid}) — شهادة`);
    if (DRY) return;
    const tx = await m.confirmCollateralReleased(id, "0x" + t.txid);
    log(`   tx ${tx.hash}`);
    await tx.wait();
    return;
  }
  log(`#${id}: بانتظار بثّ معاملة فكّ الرهن من الخزنة`);
}

main().catch((e) => {
  console.error("❌", e.message ?? e);
  process.exit(1);
});

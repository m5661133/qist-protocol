/**
 * verify-client-errors — رسائل أخطاء السقف في الموقع والتطبيق قبل الترقية.
 *
 *   NODE_PATH=$PWD/node_modules FORK_BLOCK=<كتلة> npx hardhat --config hardhat.fork.config.ts run scripts/verify-client-errors.ts
 *   (NODE_PATH: contract-errors.js في الموقع يحتاج ethers من هذا المستودع)
 *
 * على نسخة محلية من Base (لا شيء يُرسل إلى الشبكة):
 *   1. ترقية محاكاة إلى Build 22 من الـSafe (نفس مسار scripts/fork-upgrade-build22.ts).
 *   2. استدعاء createOffer عبر **ABI الموقع نفسه** (مستخرج من app.js) لإطلاق أخطاء السقف الحقيقية،
 *      وتمرير خطأ ethers كما هو إلى QistErrors.describe من contract-errors.js.
 *   3. كتابة fixtures لكل خطأ له رسالة (بيانات الرفض + الرسالة المتوقعة) يختبرها التطبيق حرفياً.
 *
 * SITE_DIR / APP_DIR اختياريان (الافتراضي: المجلدان الشقيقان).
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { PROXY, CAPS, preflight, deployBuild22, upgradeCalldata } from "./build22-upgrade";

const SITE = process.env.SITE_DIR ?? path.resolve(__dirname, "../../الموقع قسط");
const APP = process.env.APP_DIR ?? path.resolve(__dirname, "../../تطبيق الهاتف");
const ETH = ethers.ZeroAddress;
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const QistErrors = require(path.join(SITE, "contract-errors.js"));

function siteAbi(): string[] {
  const src = fs.readFileSync(path.join(SITE, "app.js"), "utf8");
  const body = src.match(/const ABI = \[([\s\S]*?)\n\];/)![1];
  return [...body.matchAll(/^\s*'([^']+)'/gm)].map((m) => m[1]);
}

const results: [string, boolean][] = [];
const ok = (n: string, c: boolean) => { results.push([n, c]); console.log(`  ${c ? "✅" : "🔴"} ${n}`); };

async function main() {
  if ((await ethers.provider.getNetwork()).chainId !== 31337n) throw new Error("⛔ محاكاة محلية فقط");
  await network.provider.send("hardhat_mine", ["0x1"]);

  console.log("── 1. ترقية محاكاة إلى Build 22");
  const pf = await preflight();
  const { implAddr } = await deployBuild22();
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [pf.owner] });
  await network.provider.send("hardhat_setBalance", [pf.owner, "0x56BC75E2D63100000"]);
  const safe = await ethers.getSigner(pf.owner);
  await (await safe.sendTransaction({ to: PROXY, data: upgradeCalldata(implAddr) })).wait();
  ok("ترقية + initializeV3(20k/15k/5k)", true);

  console.log("\n── 2. أخطاء حقيقية عبر ABI الموقع ⇒ QistErrors.describe");
  const abi = siteAbi();
  const [, seller] = await ethers.getSigners();
  const site = new ethers.Contract(PROXY, abi, seller);
  const admin = new ethers.Contract(PROXY, [
    "function totalExposureUSDC() view returns (uint256)",
    "function setCustodyCaps(uint256,uint256,uint256)",
  ], safe);
  ok(`ABI الموقع (${abi.length} مدخلاً) بلا أي خطأ مخصّص — الفكّ مستقل عنه`, !abi.some((f) => f.startsWith("error ")));

  // سعر ETH من فرق العهدة بعد عرض صغير
  const e0: bigint = await admin.totalExposureUSDC();
  const small = ethers.parseEther("0.01");
  await (await site.createOffer(ETH, CBBTC, USDC, small, 1000, 1, 3, 30 * 86400, 0, 15000, false, { value: small })).wait();
  const centi: bigint = (await admin.totalExposureUSDC()) - e0;

  const attempt = async (targetUSD: bigint) => {
    const now: bigint = await admin.totalExposureUSDC();
    const amt = ((targetUSD * 10n ** 6n - now) * small) / centi;
    try {
      await site.createOffer.staticCall(ETH, CBBTC, USDC, amt, 1000, 1, 3, 30 * 86400, 0, 15000, false, { value: amt });
      return { msg: null as string | null, raw: "" };
    } catch (e: any) {
      return { msg: QistErrors.describe(e) as string | null, raw: String(e?.shortMessage ?? e?.message) };
    }
  };
  const cases: [string, bigint, RegExp][] = [
    ["عرض ≈$10,000 ⇒ حد العروض", 10_000n, /مجموع العروض المعروضة للبيع سيصبح \$10,\d{3}، وحدّها الحالي \$5,000/],
    ["إجمالي ≈$17,500 ⇒ حد الالتزامات", 17_500n, /إجمالي الأموال في العقد \$17,500، والسقف الحالي \$15,000/],
    ["إجمالي ≈$25,000 ⇒ الحد الصارم", 25_000n, /إجمالي الأموال في العقد \$25,000، والسقف الحالي \$20,000/],
  ];
  for (const [name, usd, re] of cases) {
    const r = await attempt(usd);
    console.log(`     ethers: «${r.raw.slice(0, 60)}»\n     الموقع: «${r.msg}»`);
    ok(name, !!r.msg && re.test(r.msg));
  }
  await (await admin.setCustodyCaps(CAPS.global, 0n, 0n)).wait();
  const paused = await attempt(1_000n);
  console.log(`     الموقع: «${paused.msg}»`);
  ok("commitmentCap = 0 ⇒ الالتزامات الجديدة موقوفة", paused.msg === QistErrors.describe({ data: ethers.id("NewCommitmentsPaused()").slice(0, 10) }));

  console.log("\n── 3. fixtures للتطبيق (رسالة الموقع هي المرجع)");
  const iface = new ethers.Interface(QistErrors.SIGNATURES.map((s: string) => "error " + s));
  const samples: Record<string, any[]> = {
    GlobalCapExceeded: [17_500_000_051n, 15_000_000_000n],
    OfferCapExceeded: [10_000_000_000n, 5_000_000_000n],
    NewCommitmentsPaused: [], AccountingFault: [],
    CustodyInsolvent: [ETH, 1n, 2n],
    PositionExceedsCap: [4_500_000_000n, 4_000_000_000n],
    ActivePositionsCapReached: [5n],
    EnforcedPause: [], SlippageExceeded: [100n, 120n], StalePrice: [], SequencerDown: [],
    SequencerGracePeriodNotOver: [], InsufficientCollateral: [1n, 2n], HealthFactorTooLow: [1n, 2n],
    BelowMinPurchase: [1n, 2n], InvalidInstallments: [13, 1, 12], OfferNotActive: [],
    PositionNotActive: [], SelfBuyNotAllowed: [], TokenNotSupported: [], ZeroAmount: [],
  };
  const fixtures = Object.entries(samples).map(([name, args]) => {
    const data = iface.encodeErrorResult(name, args);
    return { name, data, message: QistErrors.describe({ data }) as string };
  });
  ok(`كل الأخطاء ذات الرسائل (${fixtures.length}) لها رسالة غير فارغة`, fixtures.every((f) => !!f.message));
  ok("خطأ بلا رسالة (OwnableUnauthorizedAccount) ⇒ null فتبقى الرسالة الاحتياطية",
    QistErrors.describe({ data: iface.encodeErrorResult("OwnableUnauthorizedAccount", [ETH]) }) === null);
  const out = path.join(APP, "test/fixtures/contract_errors.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(fixtures, null, 2) + "\n");
  console.log(`     ⇒ ${out}`);

  const failed = results.filter(([, v]) => !v);
  console.log(`\n═══ ${results.length - failed.length}/${results.length} ═══`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

# AI_HANDOFF.md — العقد الذكي (Qist Protocol)
> ملف تسليم لأي وكيل AI يبدأ العمل على هذا المشروع. آخر تحديث: 2026-08-22.
> كُتب بفحص فعلي للملفات على القرص وقت الكتابة، لا من الذاكرة.

# Project Overview

- **الاسم الداخلي في `package.json`:** `hlal-v6` (اسم قديم، لم يُعَد تسميته إلى Qist).
- **الهدف:** بروتوكول **مرابحة إسلامية لامركزية** على شبكة **Base Mainnet** (chainId 8453).
  المشتري يشتري أصلاً بالتقسيط عبر عقد ذكي بدل قرض ربوي.
- **عقدان رئيسيان حيّان:**
  1. `MurabahaV6.sol` — المسار الأساسي: أصل ETH/cbBTC، دفع بـUSDC على أقساط مع ضمان.
     نمط **UUPS Proxy** قابل للترقية + Chainlink Automation.
  2. `BtcEscrowMurabaha.sol` — المسار الأحدث: **بيتكوين حقيقي** (لا مغلَّف) بخزنة 2-of-3
     غير وصائية. هذا العقد **منشور حيّاً على Base بأموال حقيقية**.
- **مشاريع شقيقة تعتمد عليه:** `../تطبيق الهاتف` (Flutter) · `../qist-btc` (نواة Rust للبيتكوين)
  · `../الموقع قسط`.

# Tech Stack

| الطبقة | التقنية |
|---|---|
| العقود | Solidity — `hardhat.config.ts` و`foundry.toml` متوافقان على **solc 0.8.22 · viaIR · optimizer 200 · evm paris** |
| إطار العمل الأساسي | Hardhat ^2.22 + `@nomicfoundation/hardhat-toolbox` ^5 |
| طبقة fuzz/invariant | **Foundry** فوق نفس المشروع (لا يحلّ محل Hardhat) — `test/foundry/` |
| الترقيات | `@openzeppelin/hardhat-upgrades` ^3.9 + `contracts-upgradeable` ^5.6 |
| السكربتات والاختبارات | TypeScript + Ethers v6 |
| البيتكوين (جانب JS) | `bitcoinjs-lib` ^7 |

# Architecture

```
contracts/
  MurabahaV6.sol            ← العقد الأساسي (UUPS Proxy، حيّ على Base)
  BtcEscrowMurabaha.sol     ← مسار البيتكوين الحقيقي (UUPS Proxy، حيّ على Base)
  QistTimelock.sol          ← قفل زمني للحوكمة
  Mocks.sol                 ← MockERC20 + MockAggregator (اختبار فقط)
  interfaces/IChainlinkFeed.sol
  libraries/                ← Errors · MurabahaMath · PriceLib · TransferLib
test/
  MurabahaV6.comprehensive.test.ts   ← المجموعة الأساسية
  MurabahaV6.test.ts · MurabahaV6.security-fixes.test.ts
  BtcEscrowMurabaha.test.ts · BtcEscrowMurabaha.fork.test.ts
  vault-parity.test.ts               ← تطابق منطق الخزنة مع نواة Rust
  foundry/                           ← اختبارات الثوابت (invariant) وfuzz
scripts/                  ← ~60 سكربت تشغيلي/تشخيصي (نشر، ترقية، فحص أرصدة، upkeep)
  attestor-daemon.ts      ← الديمون الحيّ الذي يراقب صفقات البيتكوين (يعمل عبر LaunchAgent)
  deploy-btc-escrow.ts · upgrade_base_safe.ts · rollback-btc-escrow.ts
deployments/btc-escrow.json  ← ★ سجل الترقيات ونقاط الرجوع — اقرأه قبل أي ترقية
docs/ · .audit/           ← تقارير تدقيق ومخرجات تحليل ساكن
```

# Current State

## MurabahaV6 Build 23 — **حيّ على Base** (2026-10-06)
- **منشور ومُرقّى:** التنفيذ `0x420A2c01fe0B7DF55440227af78E7759f970B65B` · CustodyLib `0x5C1e24C7f83507a2064b91Aa9BbD7D5a39A83b9c`
  (موثّقان على Basescan) · Safe nonce 10، معاملة `0x9abc84d4…bc63a` كتلة 52,258,241 · السجل `deployments/build23-base.json`.
- **فحوص ما بعد الترقية ✅:** EIP-1967 = Build 23 · `pendingToken` = 0 · العروض 26 والمراكز 18 كما هي · غير موقوف ·
  `MODE=check` نظيف (cbBTC 549707 = المستحق). نقطة الرجوع: Build 22 (`docs/ROLLBACK.md`).
- **السبب:** تقرير `~/Desktop/مشاريع/ايجنت اسلامي/05_تقرير_ثغرة_قسط.md`، ثلاث ثغرات متوسطة مُثبتة على fork:
  F-1 بائع محظور في USDC يُفشل سداد المشتري · F-2 مشترٍ محظور في رمز الضمان يُعلّق المركز ·
  F-3 إيقاف أطول من 3 أيام يفرض تصفية جماعية عند الاستئناف.
- **R-1:** `_deliverToken` لـERC20 = `trySafeTransfer`، وإن فشل ⇒ `pendingToken[token][to]` + `totalPendingToken`
  + `PayoutDeferred`. السحب `withdrawToken(token)` لصاحبه فقط (منطقه في `CustodyLib.withdrawPending`).
  دفعتا البائع (`_chargeInstallment`، `earlyRepayCash`) صارتا عبر `_deliverToken`.
  `CustodyLib._owed` يضمّ المعلّق ⇒ **CustodyLib جديدة تُنشر وتُربط** (BuyLogic/OfferLogic/AutomationLogic كما هي).
- **R-2:** `unpause` يسجّل `lastUnpauseAt`؛ التأخّر = `now > max(nextDueDate, lastUnpauseAt) + GRACE`.
  `liquidatePositionPublic` يستدعي `isLiquidatable` (لا تكرار). تصفية هبوط السعر فورية كما هي.
- **إضافي:** `earlyRepayCash` صار CEI (الحالة قبل التحويلات).
- **التخزين:** 31 متغيراً كما هي + 3 في النهاية (slots 29–31) — مُتحقق بـ`forge inspect`. بلا initializer.
- **الحجم:** MurabahaV6 = 24,194 (هامش 382) · الحاضنة 24,526 (هامش 50) — `totalPendingToken` و`lastUnpauseAt` internal لهذا.
- **التحقق:** Hardhat 204 ✅ (منها `test/Build23.test.ts` 12، تفشل 10 منها على Build 22) · Foundry invariants 22 ✅ ·
  `test/foundry/Build23Fork.t.sol` ترقية الـProxy الحي على fork بانتحال الـSafe ⇒ الحالة محفوظة وF-1/F-2/F-3 مُصلحة ✅ ·
  Aderyn بلا تغيير · Slither +3 `reentrancy-eth` (نفس نمط `_settleByCollateral` المقبول في Build 22: تحويلان متتاليان
  تحت `nonReentrant`، وفرع ETH غير قابل للوصول لأن رمز الدفع ستابل دائماً).
- **سكربت الترقية:** `scripts/prepare-upgrade-build23-safe.ts` (+ `build23-upgrade.ts`، مرجع `contracts/legacy/b22`).
  ينشر CustodyLib جديدة فقط، ويعيد BuyLogic/OfferLogic/AutomationLogic الحية بعد مطابقة كودها. المعاملة:
  `upgradeToAndCall(impl, 0x)` بلا initializer. تجربة جافة على fork 52243172: **6/6** (الحالة محفوظة، reconcile سليم).
  **الرجوع لـBuild 22:** `upgradeToAndCall(0x962D…5DE0, 0x)` آمن للتخزين، لكن أي `pendingToken` قائم يصبح غير قابل للسحب
  حتى العودة لـBuild 23 — تحقّق أنه صفر قبل الرجوع.
- **المتبقي:** رفع التطبيق (9b3263d) إلى TestFlight ونشر الموقع (d3c4b9df) — كلاهما يعرض «مستحقات محفوظة» · تحديث حزمة التدقيق لـBuild 23.
  `custody-reconcile.ts` صار يعدّ المعلّق ERC20 مستحقاً (خانة `totalPendingToken` = 30) — اختبار في `Build23.test.ts`، Hardhat 205 ✅.

## منشور وحيّ على Base Mainnet
- **BtcEscrowMurabaha Proxy:** `0x47Ce614E8D1EBd19d66f254c062bDDEA2F3e3103`
- **المالك/الناشر:** `0xef6F0C01C1f61a798923Baf57eb515f45d68c2e4`
- **آخر implementation:** `0x0604A1Bf3f8725062fCB67323b65c4585F3b717F` (2026-08-13 — BE-13:
  رفع سقف LTV الابتدائي 80% → 87%).
- تاريخ الترقيات: **5 قيود** في `deployments/btc-escrow.json`، كل قيد يحمل `storageChange`
  و`rollbackSafe` و`why`. آخر أربع ترقيات آمنة للرجوع؛ **v1 غير آمن للرجوع** (هيكل `struct Deal` مختلف).
- **6 صفقات** موجودة على السلسلة وقت آخر تشغيل للديمون، كلها تحت المراقبة.

## الديمون (attestor)
`scripts/attestor-daemon.ts` يعمل كخدمة دائمة عبر LaunchAgent `info.qist.attestor`.
**توقّف صامتاً بين 2026-08-19 و2026-08-22** بسبب تغيّر مسار حساب الماك؛ أُصلح في 2026-08-22
ويعمل الآن. سجلاته: `~/Library/Logs/qist/attestor-launchd.log`.

## حالة git — ⚠️ اقرأ هذا قبل أي شيء
- الفرع: `main` · الـremote: `https://github.com/m5661133/qist-protocol.git`
- آخر التزام: **2026-07-18** — أي أن **كل عمل مسار البيتكوين الحقيقي غير ملتزَم**.
- **32 مساراً غير ملتزَم**، من بينها ملفات غير مُتتبَّعة أصلاً وهي جوهر المشروع الحالي:
  `contracts/BtcEscrowMurabaha.sol` · `deployments/` · `foundry.toml` · `docs/` ·
  `scripts/attestor-daemon.ts` · `scripts/deploy-btc-escrow.ts` · `.audit/`
  وتعديلات على `contracts/MurabahaV6.sol` و`contracts/libraries/PriceLib.sol`.

# Known Issues

1. **فجوة نسخ احتياطي حقيقية:** العقد المنشور حيّاً بأموال حقيقية مصدره ملف **غير مُتتبَّع في git**.
   أي فقدان للقرص = فقدان مصدر عقد حيّ. هذه أهم مخاطرة قائمة في المشروع الآن.
2. `package.json` ما زال يحمل الاسم القديم `hlal-v6` والوصف بالإنجليزية عن HLAL.
3. سكربتات `scripts/` كثيرة جداً (~60) وأكثرها تشخيصي لمرة واحدة (`check_pos5.ts`,
   `deploy_build17.ts` …) — لا تفترض أن أياً منها محدَّث أو صالح للتشغيل اليوم.
4. `attestor-launchd.log` و`attestor-launchd.err.log` ما زالا في جذر المشروع كبقايا؛
   السجلات الحيّة انتقلت إلى `~/Library/Logs/qist/`.
5. **`scripts/deploy_manual2.ts` معطَّل**: يستورد من
   `/Users/macmjls/Downloads/hlal_v6_project/node_modules/…` — مجلد لم يعد موجوداً
   على أي حساب. تُرك بلا تصحيح عمداً لأن الوجهة نفسها اختفت، لا المسار فقط.
   لا تشغّله؛ إن احتجت وظيفته أعِد كتابة الاستيراد من `node_modules` المحلي.

# Environment

- **الشبكة:** Base Mainnet (chainId 8453). يحتاج `.env` بمفاتيح RPC والناشر — **موجود محلياً ولا يُلتزَم**.
- **الحساب على الماك:** `mac2026` — المسار المنزلي `/Users/macmjls_1`
  (الحساب القديم `/Users/macmjls` لم يعد مستخدماً؛ أي مسار يشير إليه مسار ميت).
- **جذر كل المشاريع:** `~/Desktop/مشاريع/` · وغير المشاريع في `~/Desktop/منوع/`.
- **النسخ الاحتياطية:** القرص الخارجي «محمد3» عبر `~/backup-mjls.sh` (LaunchAgent يومي).
- المسار الحالي: `~/Desktop/مشاريع/العقد الذكي`

# Run / Test / Build Commands

```bash
npx hardhat compile                 # بناء
npx hardhat test                    # كل اختبارات Hardhat
npx hardhat test test/BtcEscrowMurabaha.test.ts    # مجموعة واحدة
forge test                          # اختبارات Foundry (fuzz)
forge test --match-path 'test/foundry/*'           # الثوابت (150 مسار × عمق 120)
npx hardhat run scripts/attestor-daemon.ts --network base   # تشغيل الديمون يدوياً
```

# Verification

قبل اعتبار أي تعديل على عقد ناجحاً:
1. `npx hardhat compile` نظيف.
2. `npx hardhat test` — لا فشل جديد.
3. `forge test` — لا كسر لأي ثابت (invariant).
4. لأي ترقية: تحقّق من `storageChange` وسجِّل قيداً جديداً في `deployments/btc-escrow.json`
   **قبل** تنفيذ الترقية، لا بعدها.

# Next Task (مقترح، لم يُطلب بعد)

الأولوية القصوى: **التزام مسار البيتكوين الحقيقي في git ودفعه** — العقد حيّ بأموال حقيقية ومصدره
غير محفوظ في أي مستودع. يحتاج إذناً صريحاً من المستخدم قبل التنفيذ (القاعدة 16).

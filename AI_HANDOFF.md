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

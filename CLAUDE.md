# العقد الذكي — Qist (MurabahaV6)
> اقرأ `../CLAUDE.md` أولاً للسياق الكامل للمشروع

---

## نوع المشروع
عقد ذكي إسلامي (مرابحة) على Base Mainnet، يعمل بنمط **UUPS Proxy** قابل للترقية.
المنطق: البائع ينشئ عرضاً بأصل (ETH/cbBTC)، المشتري يدفع بـ USDC على أقساط مع ضمان.

---

## اللغات المستخدمة

| اللغة | الاستخدام |
|-------|-----------|
| **Solidity ^0.8.24** | العقود الذكية (`contracts/`) |
| **TypeScript** | الاختبارات والسكريبتات (`test/`, `scripts/`) |
| **JavaScript (HardhatConfig)** | `hardhat.config.ts` |

الأدوات: Hardhat · Ethers.js v6 · OpenZeppelin Upgradeable v5 · Chainlink Automation

---

## الملفات الرئيسية

```
contracts/
  MurabahaV6.sol                        ← العقد الرئيسي — UUPS Proxy
  Mocks.sol                             ← MockERC20 + MockAggregator للاختبار
  interfaces/                           ← واجهات Chainlink + IERC20
  libraries/                            ← مكتبات مساعدة

test/
  MurabahaV6.comprehensive.test.ts      ← اختبارات شاملة ✅ (الأساسي)
  MurabahaV6.test.ts                    ← اختبارات إضافية

scripts/
  upgrade_base_safe.ts                  ← تحقق/ترقية آمنة على Base Mainnet
  perform_upkeep_base.ts                ← تشغيل Chainlink Upkeep يدوياً
  deploy-base.ts                        ← نشر أولي (مكتمل)

hardhat.config.ts                       ← إعدادات الشبكات والـ compiler
```

---

## قواعد لا تُكسر عند تعديل الكود

### 1. لا تعدّل العقد بدون تشغيل الاختبارات أولاً
```bash
# قبل أي تعديل على contracts/MurabahaV6.sol:
npx hardhat test

# النتيجة المطلوبة حالياً: 126 passing — أي فشل يعني لا ترقية
```

### 2. لا تستخدم auto mode / auto-edit على ملفات Solidity
ملفات `.sol` حساسة جداً — أي تغيير غير مدروس في المنطق أو الترتيب أو الـ storage layout
قد يُتلف بيانات الـ Proxy أو يُعطّل الترقيات. **كل تعديل يجب أن يكون يدوياً ومراجعاً**.

### 3. storage layout ثابت
لا تُعيد ترتيب متغيّرات الـ storage، ولا تحذف متغيّراً قديماً — استخدم `__gap` فقط للتوسّع.

### 4. GRACE_PERIOD يجب أن يتطابق في كل مكان
```
العقد:          GRACE_PERIOD = 259200  (3 أيام)
ملفات test/*.ts: const GRACE = 259200  ← يجب أن يتطابق دائماً
```

### 5. قاعدة checkUpkeep قبل performUpkeep
```typescript
// ❌ خطأ — سيُعطي revert فارغاً
await pool.performUpkeep("0x")

// ✅ صحيح دائماً
const [needed, perfData] = await pool.checkUpkeep.staticCall("0x")
if (needed) await pool.performUpkeep(perfData, { gasLimit: 500_000 })
```

### 6. USDC = 6 decimals دائماً (ليس 18)
```typescript
// ❌ خطأ
ethers.parseEther("100")

// ✅ صحيح
ethers.parseUnits("100", 6)
```

---

## بعد أي تغيير في العقد

```
1. npx hardhat test               ← يجب 126/126
2. إذا تغيّرت توقيعات دوال:
   - حدّث ABI في "../موقع الويب/src/configV6.js"
   - حدّث ABI في "../تطبيق الهاتف/lib/contracts/abi.dart"
3. للترقية على Base:
   npx hardhat run scripts/upgrade_base_safe.ts --network base
4. حدّث Implementation address في ../CLAUDE.md
```

---

## العناوين الحرجة (Base Mainnet)

```
Proxy (لا يتغير أبداً): 0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5
Implementation (Build 19, 2026-07-16): 0xB775F07634aD5e673261eD5cE6a03924DC0A0816  ← النشط ✅
  ⤷ D-056: emergencyWithdraw يحظر ETH/USDC/cbBTC/أي مدعوم (CannotWithdrawUserAsset) — المالك لا يمسّ أموال المستخدمين
  ⤷ يسترجع الرموز الغريبة فقط → protocolTreasury (وجهة ثابتة) · verified ✅ · 139 اختبار · Safe nonce 7
Implementation (Build 18, 2026-07-16): 0x99aD53759D0dffCC6b396831D40f96c86E2024C3  ← سابق
  ⤷ M-01 (_canAutoPay) + M-03 (totalPendingETH + guardian=Safe)
Implementation (Build 17, 2026-06-25): 0x5BE35625d652A35c38e3d8168fBB11DCF7ffbbE7  ← سابق
  ⤷ H1 (GRACE=3 أيام) + H2 (sequencer مفعّل) + M5 + caps + M-01 (فهرس نشط) + MAX_PROFIT 300%
  ⤷ Basescan verify: npx hardhat verify --network base <addr> — المفتاح في .env (Etherscan V2)
Implementation السابق (Build 16): 0xdDE63f8B1B645051EB6e7f906C638B58F8c1DbCA
USDC:   0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
cbBTC:  0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf  ← متغيّر العقد اسمه `wbtc` لكنه يشير لهذا. الواجهات تعرضه "cbBTC" (D-049). لا تُعد تسمية الـ storage.
```

---

## المتغيّرات الحرجة (Build 16)

```
AUTO_PAY_FEE_BPS       = 30   (0.3% إضافية على القسط التلقائي)
AUTO_LIQUIDATE_FEE_BPS = 50   (0.5% من حصة البائع عند التصفية التلقائية)
protocolFeeBps         = 100  (1%)
brokerageFeeBps        = 50   (0.5% لكل طرف)
MAX_BROKERAGE_FEE_BPS  = 100  (1%)
MAX_PROTOCOL_FEE_BPS   = 300  (3%)
MAX_PROFIT_BPS         = 30000 (300% — السوق عرض وطلب)
MAX_PAYMENT_INTERVAL   = 365 days
MIN_COLLATERAL_RATIO   = 11000 (110%)
LIQUIDATION_THRESHOLD  = 10500 (105%)
GRACE_PERIOD           = 259200 (3 أيام) ✅ منشور Build 17
MAX_PROFIT_BPS         = 30000 (300% — السوق عرض وطلب)
sequencerUptimeFeed    = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433 (H2 نشط)
```

---

## ما هو مؤجّل (لا تفعله الآن)

```
⏳ نشر عقود الدرهم/الدينار         ← بعد التدقيق الأمني
```

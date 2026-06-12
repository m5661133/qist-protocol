# HLAL V6 — مرابحة إسلامية بضمان كريبتو

عقد ذكي لتمويل إسلامي (مرابحة) على Ethereum. البائع يعرض أصلاً (ETH/WBTC)،
المشتري يرهن ضماناً كريبتو ويستلم الأصل فوراً، ويسدد بـ USDC أقساطاً.

## الإعداد

```bash
# 1. ثبّت الاعتماديات
npm install

# 2. اضبط البيئة
cp .env.example .env
# املأ SEPOLIA_RPC_URL و PRIVATE_KEY في .env

# 3. ترجم العقود
npm run compile
```

## الاختبار

```bash
# اختبارات Hardhat الكاملة (مسار ETH + WBTC + التصفية + الوقت)
npm test
```

هذه الاختبارات تغطي ما لم يكن ممكناً في بيئة التطوير المعزولة:
- تحويل ETH الفعلي (مسار ضمان/بيع ETH)
- دورة الإكمال الكاملة وإرجاع الضمان
- تقدّم الوقت للمهلة (3 أيام) والتصفية

## النشر على Sepolia

```bash
npm run deploy:sepolia
```

سينشر MockUSDC + MockWBTC + MurabahaV6 ويطبع العناوين.
عناوين Chainlink مضبوطة مسبقاً (ETH/USD و BTC/USD على Sepolia).

### بعد النشر
1. تحقق من العقد عبر أمر `hardhat verify` المطبوع.
2. سجّل keeper في Chainlink Automation للدفع التلقائي.
3. اضبط feeRecipient لمحفظة الرسوم.

## القرارات والذاكرة

كل قرار تصميمي موثّق في `project-memory` skill (D-001..D-018).
راجع CHANGELOG للتفاصيل.

## ⚠️ قبل Mainnet — إلزامي

1. **مراجعة شرعية**: 6 نقاط (SR-001..SR-006) تحتاج عالم شريعة متخصص.
   أهمها SR-005 (تكييف ETH/WBTC: أصل أم نقد) — المشروع كله يقوم عليها.
2. **تدقيق أمني احترافي** (audit) — لا تنشر عقداً مالياً على Mainnet بدونه.
3. **CODE-V5-3**: بيع الضمان عبر Uniswap + TWAP (مؤجل لـ V6.1).

## البنية

```
contracts/
  MurabahaV6.sol          — النواة (18 قراراً)
  libraries/              — Errors, PriceLib, MurabahaMath, TransferLib
  interfaces/             — IChainlinkFeed
  Mocks.sol               — توكنات ومغذّيات اختبار
scripts/deploy-v6.ts      — نشر Sepolia
test/MurabahaV6.test.ts   — اختبارات كاملة
```

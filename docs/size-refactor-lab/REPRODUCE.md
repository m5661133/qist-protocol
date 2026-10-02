# إعادة إنتاج نتائج تجربة الحجم (B6) من المستودع وحده

جولة 2026-10-03: أُعيد البناء من `HEAD` + الرقع أدناه في مجلد معزول، دون لمس نسخة العمل.
اكتُشف أن الرقعتين الأصليتين لا تكفيان: اختبارات الترحيل والمقارنة السلوكية تحتاج
`contracts/legacy/b21/*` (مصدر Build 21، git `6bbc11a`، العقد بإسم `MurabahaV6Build21`)
و`contracts/MurabahaV6Baseline.sol` (نسخة العمل قبل إعادة الهيكلة، بإسم `MurabahaV6Baseline`).
بدونهما تفشل 4 اختبارات بـ `HH700: Artifact for contract "MurabahaV6Build21" not found`.
أُضيفت `test-fixtures.patch` لسدّ ذلك (ملفات اختبار فقط، لا تُنشر).

## الخطوات

```bash
R="<مسار العقد الذكي>"; S=$(mktemp -d)
cd "$R" && git archive <commit-الأساس> | tar -x -C "$S"   # HEAD قبل 35ea7d7 أو بعده — الرقع لا تمس docs
cd "$S" && ln -s "$R/node_modules" node_modules && git init -q
git apply "$R/docs/size-refactor-lab/working-copy-vs-HEAD.patch"   # = نسخة العمل (السقف، 28,099)
git apply "$R/docs/size-refactor-lab/B6-vs-working-copy.patch"     # = B6
git apply "$R/docs/size-refactor-lab/test-fixtures.patch"          # Build 21 + Baseline للاختبار
npx hardhat test
DIFF_UNLIMITED=1 npx hardhat --config hardhat.diff.config.ts test test/BuildDiff.behavior.test.ts
node -e 'const a=require("./artifacts/contracts/MurabahaV6.sol/MurabahaV6.json");console.log((a.deployedBytecode.length-2)/2)'
```

## النتائج المقاسة في جولة إعادة الإنتاج

| البند | النتيجة |
|---|---|
| تطابق المصادر مع مجلد التجربة | كل ملفات `contracts/` و`test/` متطابقة بايتاً ببايت |
| `npx hardhat test` | 179 ناجح · 5 معلّقة (المقارنة السلوكية، تعمل بالإعداد المنفصل) · 0 فاشل |
| المقارنة السلوكية | 5/5: البذور 20261001 / 7 / 424242 = 314 + 251 + 234 = **799 حدثاً متطابقاً**؛ الأخطاء نفس selector والوسائط |
| حجم MurabahaV6 (runtime) | **23,740** بايت (هامش 836) |
| المكتبات | BuyLogic 3,941 · CustodyLib 2,971 · AutomationLogic 1,477 · OfferLogic 1,203 |

## ما زال غير مُتحقق

- اختبارات Foundry (`forge` غير مثبّت على الجهاز).
- سكربت الترقية مع ربط المكتبات الأربع والتحقق من كودها على السلسلة.
- خيار `setParam` (23,449) قيس فقط؛ لا رقعة ولا اختبارات لكل مفتاح وصلاحية وحد وحدث.

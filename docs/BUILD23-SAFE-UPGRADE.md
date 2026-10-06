# دليل ترقية Build 23 عبر الـ Safe

> **ما يُصلحه:** F-1 وF-2 وF-3 من تقرير `ايجنت اسلامي/05_تقرير_ثغرة_قسط.md`.
> - **R-1:** إن تعذّر إرسال USDC أو cbBTC يُسجَّل المبلغ لصاحبه بدل أن تفشل العملية.
> - **R-2:** مهلة 3 أيام جديدة بعد كل استئناف للعقد.
>
> **المصدر:** الفرع `build23`. الفرع الرئيسي `main` **لا** يحتوي التعديلات.
> **المعاملة:** `upgradeToAndCall(<تنفيذ Build 23>, 0x)`، بلا تهيئة ولا ترحيل.
> **المنفّذ:** أنت. السكربت ينشر عقدين من محفظة النشر، والترقية نفسها بتوقيعين من ثلاثة على الـ Safe.

| البند | القيمة |
|---|---|
| Proxy | `0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5` |
| المالك (Safe 2/3) | `0x64D738021BAe4cb9a7fd82529C2F94f61d404064` |
| التنفيذ الحي (Build 22) | `0x962DD7Ad2AaA80eFF2Ea303Ae7E901A0A39C5DE0` |
| بصمة كوده (keccak256) | `0x0f2e85eea4043e8d98c00a7721af780bca5b47e9ea1a2e6174cfabb95751ff81` |
| نسخة التهيئة | 3، وتبقى 3 بعد الترقية |
| مكتبات تُعاد كما هي | BuyLogic `0x2b30…9DDc` · OfferLogic `0x550b…37A4` · AutomationLogic `0x9b45…9AA3` |
| مكتبة جديدة | `CustodyLib`، لأن توقيعها تغيّر. القديمة `0xF521…5244` **لا تصلح** |

---

## الخطوة 0: فحوص قبل البدء (لا شيء يُرسل)

شغّلها من مجلد «العقد الذكي».

```bash
git checkout build23
```

```bash
git status --short
```

لا يجب أن يظهر أي تعديل على `contracts/` أو `scripts/`.

```bash
npx hardhat test
```

المتوقع: **204 ناجحة و5 معلّقة.**

```bash
FORK_BLOCK=$(cast block-number --rpc-url https://mainnet.base.org) npx hardhat --config hardhat.fork.config.ts run scripts/prepare-upgrade-build23-safe.ts
```

المتوقع: **6/6**، ثم «المعاملة جاهزة».

**اختياري:** السيناريوهات الوظيفية للثغرات على نسخة الشبكة، اختبار واحد في كل تشغيل:

```bash
BASE_FORK_URL=https://mainnet.base.org forge test --match-test test_F1 --evm-version cancun -vv
```

**شرط:** محفظة النشر في `.env` (`PRIVATE_KEY`) فيها قليل من ETH على Base لرسوم نشر عقدين. كلفتها أقل من دولار عادةً.

## الخطوة 1: النشر (عقدان فقط، لا يلمس الـ Proxy)

```bash
npx hardhat run scripts/prepare-upgrade-build23-safe.ts --network base | tee deployments/build23-deploy.log
```

يفعل السكربت بالترتيب:
1. يتحقق أن الحي هو Build 22، وأن البصمة مطابقة، والتهيئة 3، والمالك الـ Safe. أي اختلاف يوقفه قبل نشر أي شيء.
2. ينشر `CustodyLib` الجديدة، ثم `MurabahaV6` المربوط بها وبالمكتبات الثلاث الحية.
3. يطابق الكود المنشور مع المُجمَّع محلياً حرفياً.
4. يتحقق من التخزين مقارنة بـ Build 22 الحي.
5. يطبع **To / Value / Data** لمعاملة الـ Safe.

انسخ من المخرجات: **عنوان CustodyLib الجديدة**، و**عنوان التنفيذ**، و**Data**.

## الخطوة 2: تحقق مستقل من المنشور (لا نشر)

```bash
LIB_CustodyLib=<عنوان CustodyLib> IMPL_BUILD23=<عنوان التنفيذ> FORK_BLOCK=$(cast block-number --rpc-url https://mainnet.base.org) \
  npx hardhat --config hardhat.fork.config.ts run scripts/prepare-upgrade-build23-safe.ts
```

المتوقع: **6/6**، و**Data مطابقة حرفياً** لما طُبع في الخطوة 1. يعني هذا أن العقدين المنشورين فعلاً هما ما اختُبر، وأن الترقية بهما تنجح على حالة الشبكة الآن.

## الخطوة 3: التوثيق على Basescan (المكتبة أولاً)

```bash
npx hardhat verify --network base <عنوان CustodyLib>
```

ثم التنفيذ مع المكتبات الأربع:

```bash
npx hardhat verify --network base <عنوان التنفيذ> --libraries libs-build23.js
```

محتوى `libs-build23.js`، وهو ملف محلي مؤقت:

```js
module.exports = {
  CustodyLib: "<عنوان CustodyLib>",
  BuyLogic: "0x2b307BdEBe421cb529c27736EC74143a7C1e9DDc",
  OfferLogic: "0x550b8Cf91D9338d578D426BACB4e9653553037A4",
  AutomationLogic: "0x9b459e5f6b1A5195f5Cc1f7e5B8C277D8Dc99AA3",
};
```

التوثيق يتيح للموقّعين قراءة الكود على Basescan قبل التوقيع.

## الخطوة 4: معاملة الـ Safe

**الموقّع الأول:**
1. افتح `app.safe.global`، واختر شبكة **Base**، ثم الـ Safe `0x64D7…4064`.
2. اختر **New transaction**، ثم **Transaction Builder**.
3. فعّل **Custom data** وأدخل:
   - **To:** `0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5`
   - **Value:** `0`
   - **Data:** القيمة من الخطوة 1
4. اضغط **Add transaction**، ثم **Create batch**.
5. **تحقق من المعاملة المفكوكة** قبل أي توقيع:
   - يجب أن تقرأ `upgradeToAndCall(newImplementation = <عنوان التنفيذ>, data = 0x)`.
   - قارن العنوان **حرفاً بحرف** بما في الخطوة 1 وعلى Basescan.
   - تبدأ Data دائماً بـ `0x4f1ef286` وتنتهي بأصفار، لأن `data` فارغة.
6. اضغط **Simulate** (Tenderly). يجب أن تنجح.
7. اضغط **Send batch**، ثم وقّع.

**الموقّع الثاني:**
1. يفتح المعاملة المعلّقة في الـ Safe.
2. يكرر التحقق في البند 5 بنفسه. يُستحسن أن يشغّل الخطوة 2 من جهازه.
3. يشغّل **Simulate** مرة أخرى.
4. يضغط **Confirm**، ثم **Execute**.

> لا حاجة لإيقاف العقد، فالترقية ذرّية ولا ترحيل فيها. أوقِف أولاً فقط إن كان هناك طارئ قائم.
> **قبل التنفيذ مباشرة:** إن تغيّر التنفيذ الحي لأي سبب، فلا تنفّذ. سيفشل التحقق في الخطوة 2.

## الخطوة 5: تحقق بعد التنفيذ

```bash
cast storage 0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url https://mainnet.base.org
```

يجب أن يظهر **عنوان التنفيذ الجديد**.

```bash
cast call 0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5 "pendingToken(address,address)(uint256)" 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 0x64D738021BAe4cb9a7fd82529C2F94f61d404064 --rpc-url https://mainnet.base.org
```

يجب أن تُرجع **0**. هذا يثبت أن R-1 صار حياً.

```bash
cast call 0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5 "nextOfferId()(uint256)" --rpc-url https://mainnet.base.org
```

```bash
cast call 0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5 "nextPositionId()(uint256)" --rpc-url https://mainnet.base.org
```

العددان يجب أن يطابقا ما قبل الترقية.

```bash
MODE=check npx hardhat run scripts/reconcile-custody.ts --network base
```

يجب أن يكون نظيفاً، أي بلا انحراف ولا عجز.

بعدها افتح التطبيق والموقع: المحفظة لا يجب أن تعرض «مستحقات محفوظة» لأحد.

## الخطوة 6: التوثيق المحلي بعد النجاح

1. أنشئ `deployments/build23-base.json` بنمط `build22-base.json`: التنفيذ، والمكتبات الأربع، وData، ورابط معاملة الـ Safe، والتاريخ، و`rollback.build22`.
2. ضع tag محلياً `build23-deployed-src` على الـ commit المنشور، وادمج `build23` في `main` محلياً.
3. حدّث العناوين الحرجة في `CLAUDE.md`، واجعل Build 22 نقطة الرجوع.
4. حدّث `docs/ROLLBACK.md` و`AI_HANDOFF.md`.
5. حدّث `currentImplementation` في التطبيق (`lib/core/config.dart`).
6. أعد الاختبار الشامل لخادم MCP، لأن `withdrawable` و`build_withdraw` للرموز صارا يعملان.

## الرجوع إلى Build 22 إن ظهرت مشكلة

1. `pause()` من الـ Safe أو الحارس إن كانت الأموال في خطر.
2. **تحقق أنه لا مستحقات معلّقة.** يمكن جمعها من أحداث `PayoutDeferred` مطروحاً منها `PayoutWithdrawn`. أي مستحق قائم يصبح غير قابل للسحب على Build 22 حتى العودة إلى Build 23.
3. من الـ Safe على الـ Proxy: `upgradeToAndCall(0x962DD7Ad2AaA80eFF2Ea303Ae7E901A0A39C5DE0, 0x)`.
   - هذا آمن للتخزين، لأن متغيرات Build 23 الثلاثة مُلحقة في النهاية (الخانات 29 إلى 31) ويتجاهلها Build 22.
4. تحقق أن خانة EIP-1967 تشير إلى Build 22 وأن بصمة الكود هي `0x0f2e…ff81`.
5. **العودة لاحقاً إلى Build 23** تكون بتبديل العنوان فقط، بلا مصالحة. سبب ذلك أن Build 22 يحدّث عدّادات العهدة نفسها، والمعلّق لا يتغير أثناءه.

## ما تغيّر للمستخدمين بعد الترقية

- **البائع المحظور في USDC:** سداد المشتري ينجح، ويُحفظ القسط للبائع حتى يسحبه بعد رفع الحظر.
- **المشتري المحظور في cbBTC:** المركز يكتمل أو يُصفّى بشكل طبيعي، ويُحفظ ضمانه له.
- **بعد أي استئناف للعقد:** مهلة 3 أيام كاملة للسداد. التصفية عند هبوط السعر تبقى فورية.
- **دوال جديدة:** `pendingToken(token, account)` و`withdrawToken(token)`، والحدثان `PayoutDeferred` و`PayoutWithdrawn`.
- التطبيق والموقع جاهزان لها في التعديلات المحلية `9b3263d` و`d3c4b9df`، ويعملان قبل الترقية وبعدها.

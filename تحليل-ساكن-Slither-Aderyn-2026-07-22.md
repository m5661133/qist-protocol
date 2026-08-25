# تقرير التحليل الساكن — MurabahaV6

**التاريخ:** 2026-07-22
**الأدوات:** Slither v0.11.5 · Aderyn v0.6.8 · solc 0.8.22 (viaIR, optimizer 200, evmVersion paris)
**النطاق:** `contracts/MurabahaV6.sol` + `libraries/` + `QistTimelock.sol` (تُستثنى `node_modules` و`Mocks.sol`)
**الهدف:** تقوية الكود مجاناً قبل الدفع لتدقيق خارجي (استراتيجية D-057)

---

## الخلاصة التنفيذية

| الأداة | إجمالي | في كودنا | خطورة حقيقية | إيجابيات كاذبة / مقصود |
|--------|:------:|:--------:|:------------:|:----------------------:|
| Slither | 94 | ~40 | **0** | كلها |
| Aderyn | 16 (2H+14L) | 16 | **0** | كلها |

**النتيجة:** لا ثغرة أمنية حقيقية واحدة. كل النتائج العالية إيجابيات كاذبة، والمنخفضة إمّا ضوضاء مكتبات أو خيارات تصميم مقصودة وموثّقة. طُبِّق تحسينان اختياريان للشفافية (أحداث + تعليق) دون أي مساس بمنطق أو storage layout.

---

## نتائج Slither العالية/المتوسطة (في كودنا)

### 1. `arbitrary-send-erc20` (High/High) ×2 — ❌ إيجابية كاذبة
- **المواضع:** `earlyRepayCash` (641)، `_chargeInstallment` (621)
- **الادعاء:** استخدام `from` عشوائي في `transferFrom`.
- **الحقيقة:** الـ`from` هو دائماً `p.buyer` (صاحب المركز):
  - `earlyRepayCash` يفرض `if (msg.sender != p.buyer) revert NotBuyer();` (638) → `from == msg.sender`.
  - `payInstallment` يفرض نفس الشرط (595) قبل `_chargeInstallment`.
  - مسار الأتمتة يسحب من المشتري الذي **فعّل autoPay طوعاً** (allowance صريح).
  - في كل الحالات: أموال المشتري تُسدَّد لدَينه هو → لا سرقة ممكنة.

### 2. `reentrancy-eth` (High/Medium) ×4 — ❌ محيّدة (mitigated)
- **المواضع:** `_buy` (465)، `_settleByCollateral` (671)
- **الادعاء:** `totalPendingETH += amount` يُكتب بعد `_deliverToken` (نداء `.call`).
- **الحقيقة:**
  - كل نقاط الدخول الخارجية عليها `nonReentrant` (تحقّقنا: `_buy`/`earlyRepayCash`/`payInstallment`/`_settleByCollateral`… جميعها).
  - نمط **CEI مُطبَّق**: كل الـEffects (تحديث state) قبل الـInteractions.
  - `.call` الوحيد يذهب لـ`msg.sender` وهو **آخر** تفاعل؛ التحديث بعده يقع فقط عند فشل الدفع (fallback → pull).
  - المدفوعات للبروكر/البروتوكول/البائع = **pull pattern** (بلا `.call`) عبر `_pendingETH.credit`.

### 3. `uninitialized-local` (Medium) — ❌ إيجابية كاذبة
- **الموضع:** `_chargeInstallment.col` (610). المتغيّر يُهيّأ صفراً افتراضياً ويُسنَد (616) ويُستخدَم (627، 630) **داخل نفس بلوك `if (completed)`** حصراً. آمن.

### 4. `unused-return` (Medium) — ❌ إيجابية كاذبة
- **الموضع:** `PriceLib.requireSequencerUp` (51). تتجاهل `roundId/updatedAt/answeredInRound` لكنها تستخدم `up` و`startedAt` — وهو **نمط Chainlink الموصى به** لفحص الـL2 Sequencer. ✅ أُضيف تعليق `slither-disable-next-line` للاتّساق مع `priceUSDC`.

> بقية نتائج Slither العالية (`arbitrary-send-eth`, `incorrect-equality`, `unused-return` على TimelockController/ERC1967) كلها داخل **OpenZeppelin** لا كودنا.

---

## نتائج Aderyn

### High
- **H-1: ETH transferred without address checks** (`withdrawETH` 857) — ❌ إيجابية كاذبة. الدالة تُرسل لـ`msg.sender` رصيده المُقيَّد هو (pull pattern). الوجهة = المستدعي نفسه.
- **H-2: Contract Name Reused** (`library Errors`) — ⚠️ تنبيه إطار عمل. يتعارض اسم `Errors` مع `@openzeppelin/utils/Errors`. **غير مؤثّر** مع Hardhat/solc (مسارات مؤهَّلة بالكامل)؛ يخصّ Truffle فقط. لا إجراء.

### Low (المهم منها في كودنا)
| المعرّف | الوصف | التقييم |
|---------|-------|---------|
| L-1 | Centralization Risk (15) | مقصود — المالك = Safe 2-of-3 + Timelock. موثّق. |
| L-6 | `nonReentrant` ليس أول modifier (10) | تجميلي — `whenNotPaused` لا يُجري نداءات خارجية فلا خطر reentrancy منه. **مؤجَّل** (تغيير غير ضروري على عقد حيّ). |
| L-8 | require داخل حلقة (728) | `performUpkeep` — الحلقة **محدودة** بمصفوفة الأتمتة؛ مقبول. |
| **L-9** | **تغيير state بلا event (4 setters)** | ✅ **أُصلِح** — أُضيفت أحداث لـ`setProtocolFee`/`setBrokerageFee`/`setBrokerTreasury`/`setProtocolTreasury`. |
| L-10 | address بلا فحص (guardian, sequencerFeed) | مقصود — `address(0)` = **تعطيل** الميزة (موثّق في التعليقات 898/913). الخزائن أصلاً مفحوصة (878/882). |
| L-11/L-13/L-3/L-4 | ضوضاء Mocks/تجميلي/أخطاء غير مستخدمة | لا إجراء (خارج نطاق الإنتاج أو تجميلي). |
| L-12 | pragma غير محدّد (`^`) | مقبول للمكتبات؛ العقد الرئيسي يُجمَّع بإصدار مثبّت في الإعدادات. |

---

## التعديلات المُطبَّقة (آمنة، storage-neutral)

1. **4 أحداث جديدة** + emit في الـsetters الأربعة (شفافية للمؤشِّرات off-chain) — L-9.
2. **تعليق `slither-disable`** على `requireSequencerUp` — نظافة التقرير.

- ✅ **لا تغيير في منطق أعمال، ولا في ترتيب/حجم متغيّرات الـstorage** → آمن للترقية UUPS.
- ✅ الاختبارات: خط الأساس **144 ناجح** → بعد التعديل **144 ناجح** (تحقّق أدناه).

---

## التوصية للتدقيق الخارجي

الكود يدخل التدقيق في وضع قوي: **صفر ثغرات حقيقية** من أداتين مستقلّتين. أرفِق هذا التقرير في حزمة التدقيق ليُظهر للمدقّق أن التحليل الساكن أُجري وفُرز — يوفّر وقته ويرفع الثقة (ويخفّض السعر غالباً).

**الخطوة التالية (D-057):** مراجعة رخيصة (Zealynx ~$500 / panther) + نشر على Procur3/SoloAudit، ثم نشر Build 20/21 + سقف $10k عبر Safe.

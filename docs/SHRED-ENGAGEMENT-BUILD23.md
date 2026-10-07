# Shred Security — تكليف التدقيق (Build 23)

**القرار:** المالك اختار Shred Security في 2026-10-07. العرض: $1,000، خمسة أيام عمل، دفع 50/50، والمراجعة تشمل كل الإصلاحات.
**المدققان:** Kenzo وYashar.
**الحالة:** لم يُقبل العرض على Procur3 بعد، ولم يُدفع شيء.

## لماذا تغيّر النطاق؟
عرض Shred كان على الوسم `build22-deployed-src`. لكن العقد الحي على الشبكة منذ 2026-10-06 هو **Build 23**، وتحقّقت من ذلك في 2026-10-07 من slot ERC1967.

| | Build 22 (العرض) | Build 23 (الحي) |
|---|---|---|
| Implementation | `0x962DD7Ad…5DE0` | `0x420A2c01…B65B` |
| الوسم | `build22-deployed-src` (c971531) | `build23-deployed-src` (5b4903b) |
| الحجم | ~1,267 nSLOC | ~1,296 nSLOC (+29) |

**ما تغيّر في الكود (ملفان فقط، والملفات الـ12 نفسها):**
- `MurabahaV6.sol`:
  - R-1 `_deliverToken`، وهو نمط push-or-credit مع `pendingToken`/`totalPendingToken`/`withdrawToken`.
  - R-2 `lastUnpauseAt`، فلا تبدأ مهلة التأخّر قبل آخر استئناف.
  - CEI في `earlyRepayCash`.
  - ثلاثة متغيّرات أُلحقت في الخانات 29–31.
- `libraries/CustodyLib.sol`: `pendingTok` يدخل في حساب المستحق `_owed`، وفي السقف (I2) والمصالحة، وأُضيفت `withdrawPending`. هذه المكتبة أُعيد نشرها على `0x5C1e24C7…3b9c`.

## المطلوب قبل إرسال رسالة القبول
1. **منح Shred وصولاً للمستودع الخاص** `github.com/m5661133/qist-protocol`.
   - الفرع `main` المحلي متقدّم بسبعة commits عن GitHub، والوسم `build23-deployed-src` غير مرفوع.
   - لذلك يلزم `git push origin main build23-deployed-src`، **بطلب صريح من المالك**.
2. إضافة حسابَي GitHub للمدققين بصلاحية قراءة فقط. اطلب أسماء الحسابات منهم في الرسالة.

## رسالة القبول (تُرسل على Procur3 بعد موافقة المالك، في سطر واحد)
> Hello Ankur, thank you for the detailed answers. We have selected Shred Security for this engagement. One scope update before we accept on Procur3: Build 23 went live on 2026-10-06, so the audit target is now the deployed code at tag build23-deployed-src (implementation 0x420A2c01fe0B7DF55440227af78E7759f970B65B, CustodyLib 0x5C1e24C7f83507a2064b91Aa9BbD7D5a39A83b9c). It is the same 12 files; the only changes vs Build 22 are in MurabahaV6.sol and CustodyLib.sol (+29 nSLOC, ~1,296 total): push-or-credit ERC20 payouts (pendingToken/withdrawToken), overdue grace restarting after unpause (lastUnpauseAt), and CEI in earlyRepayCash. The full diff is in contracts/legacy/b22/ and AUDIT_PACKAGE.md §8 lists known issues, including the open ones. Please confirm that the $1,000 price, 5 working days, 50/50 payment and fix re-review stay the same for Build 23, and send the GitHub usernames of Kenzo and Yashar so we can grant read access to the private repository. Once confirmed we will accept your proposal on Procur3.

**الترجمة:** شكراً على الإجابات التفصيلية، اخترناكم. قبل القبول على Procur3 هناك تحديث واحد في النطاق: Build 23 صار حياً في 6 أكتوبر، فالتدقيق يكون على الوسم `build23-deployed-src`. الملفات الـ12 نفسها، والتغيير في ملفين فقط (+29 سطراً). الفرق موجود في `contracts/legacy/b22/`، والمشاكل المعروفة في القسم 8 من الحزمة. أكّدوا أن السعر والمدة والدفع 50/50 ومراجعة الإصلاحات تبقى كما هي، وأرسلوا حسابات GitHub للمدققين لنعطيهم صلاحية قراءة. بعد التأكيد نقبل العرض.

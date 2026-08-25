// تدقيق أمني متوازٍ لـ MurabahaV6 — يُشغَّل عبر أداة Workflow (يحتاج تفعيل صريح: "use a workflow" / ultracode).
// يجسّد سير عمل المرحلة 7: وكيل لكل فئة ثغرات بالتوازي، ثم تحقّق نقدي من كل ملاحظة.
export const meta = {
  name: 'security-audit',
  description: 'تدقيق أمني متوازٍ لعقد MurabahaV6 عبر عدة وكلاء متخصّصين ثم تحقّق نقدي من كل ملاحظة',
  phases: [
    { title: 'تدقيق', detail: 'وكيل لكل فئة ثغرات بالتوازي' },
    { title: 'تحقّق', detail: 'تحقّق نقدي من كل ملاحظة' },
  ],
}

const PROJ = '/Users/macmjls_1/Desktop/مشاريع/العقد الذكي'

const DIMENSIONS = [
  { key: 'upgrade-access', prompt: `دقّق ${PROJ}/contracts/MurabahaV6.sol — فئتان فقط: أمان الترقية (UUPS: __gap، _authorizeUpgrade، initializer/reinitializer، تخطيط التخزين) والتحكم بالصلاحيات (كل دالة حسّاسة محميّة). اقرأ فقط، لا تُعدّل.` },
  { key: 'reentrancy', prompt: `دقّق ${PROJ}/contracts/MurabahaV6.sol و libraries/TransferLib.sol — إعادة الدخول (CEI، تغطية nonReentrant)، الاستدعاءات الخارجية، معالجة ERC20 (SafeERC20، fee-on-transfer)، ETH بنمط pull. اقرأ فقط.` },
  { key: 'math-oracle', prompt: `دقّق ${PROJ}/contracts/MurabahaV6.sol و libraries/{MurabahaMath,PriceLib}.sol — صحّة الحساب (قسمة قبل ضرب، تقريب)، الأوراكل (فحص L2 sequencer، staleness)، منطق التصفية والصحّة. اقرأ فقط.` },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          location: { type: 'string', description: 'الملف:السطر' },
          description: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['title', 'severity', 'location', 'description'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    isReal: { type: 'boolean' },
    calibratedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info', 'false-positive'] },
    reasoning: { type: 'string' },
  },
  required: ['isReal', 'calibratedSeverity', 'reasoning'],
}

// تدقيق ثم تحقّق — كل فئة تتحقّق ملاحظاتها فور اكتمالها (pipeline، لا حاجز)
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `audit:${d.key}`, phase: 'تدقيق', schema: FINDINGS_SCHEMA }),
  (review, d) => parallel((review?.findings || []).map(f => () =>
    agent(`تحقّق نقدياً من هذه الملاحظة مقابل الكود الفعلي (الوكلاء قد يبالغون). الملاحظة: "${f.title}" عند ${f.location}. هل هي حقيقية؟ وما خطورتها المُعايَرة؟`,
      { label: `verify:${d.key}`, phase: 'تحقّق', schema: VERDICT_SCHEMA })
      .then(v => ({ ...f, verdict: v }))))
)

const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
log(`اكتمل التدقيق: ${confirmed.length} ملاحظة مؤكَّدة بعد التحقّق`)
return { confirmed }

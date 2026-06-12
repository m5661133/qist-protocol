#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# المرحلة 6 — Hook: فحص أنواع TypeScript تلقائياً بعد كل تعديل
#
# يعمل تلقائياً (حدث PostToolUse) بعد Edit/Write/MultiEdit — لا يُستدعى يدوياً.
# يستقبل JSON من Claude Code على stdin، ويستخرج مسار الملف المُعدّل.
#
# مُفصّل على هذا المشروع: يتجاهل أخطاء typechain-types/ (كود مولّد لا يجتاز
# الفحص الصارم) ويُبلّغ فقط عن أخطاء حقيقية في كودك (test/ scripts/ config).
# ──────────────────────────────────────────────────────────────────────
input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null)

# تجاهل أي ملف ليس TypeScript
case "$file" in
  *.ts) ;;
  *) exit 0 ;;
esac

# جذر المشروع: من Claude Code عبر CLAUDE_PROJECT_DIR، أو اشتقاقاً من موقع السكربت
proj="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$proj" ]; then
  proj="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
cd "$proj" 2>/dev/null || exit 0
[ -x node_modules/.bin/tsc ] || exit 0

out=$(node_modules/.bin/tsc -p tsconfig.json --noEmit 2>&1)
real=$(printf '%s\n' "$out" | grep 'error TS' | grep -v 'typechain-types/')

if [ -n "$real" ]; then
  {
    echo "⚠️ فحص الأنواع (tsc) وجد أخطاء بعد تعديل: $file"
    printf '%s\n' "$real" | head -30
  } >&2
  exit 2   # exit 2 → تُعاد الأخطاء إلى Claude تلقائياً ليصلحها
fi
exit 0

#!/usr/bin/env bash
# Проверка импортёра на синтетической выгрузке: DISPOSABLE база с миграциями 0001-0003 (не боевая!).
# Usage: TEST_DATABASE_URL=postgres://... db/tests/run-import-test.sh
set -euo pipefail
: "${TEST_DATABASE_URL:?set TEST_DATABASE_URL to a disposable test database}"
R="$(cd "$(dirname "$0")/../.." && pwd)"; O="$(mktemp -d)"
node "$R/tools/neon-import.js" "$R/db/tests/fixtures/export-sample" "$O" >/dev/null
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$O/neon-import.sql"
c=$(psql "$TEST_DATABASE_URL" -Atq -c "SELECT (SELECT count(*) FROM characters)||'/'||(SELECT count(*) FROM market_listings WHERE status='cancelled')||'/'||(SELECT count(*) FROM clan_members)")
[ "$c" = "3/1/2" ] && echo "OK   импорт синтетической выгрузки ($c)" || { echo "FAIL $c"; exit 1; }
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$O/neon-import.sql" >/dev/null 2>&1 && { echo "FAIL повторный импорт не остановлен"; exit 1; } || echo "OK   повторный импорт в непустую базу остановлен"
echo "Тест оставил данные в базе: используйте одноразовую базу."

#!/usr/bin/env bash
# БОЕВОЙ импорт: выгрузка Firestore -> импорт в боевую базу Neon (relational + fs_docs). Данные игроков остаются на раннере
# и удаляются в конце; в лог попадают только счётчики. Отказывается работать, если в боевой базе уже есть данные.
set -euo pipefail
: "${U:?нужен секрет NEON_PROD_DATABASE_URL}"
R="$(cd "$(dirname "$0")/.." && pwd)"; W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
Q() { psql "$U" -v ON_ERROR_STOP=1 -Atq "$@"; }
export PGSSLMODE=verify-full
[ "$(Q -c "select to_regclass('public.fs_docs') is not null")" = "t" ] || { echo "ОШИБКА: нет схемы (запусти neon-prod mode=schema)"; exit 1; }
if [ "$(Q -c "select (select count(*) from fs_docs)+(select count(*) from users)")" != "0" ]; then echo "ОШИБКА: боевая база не пустая — импорт остановлен"; exit 1; fi
echo "== экспорт Firestore (только счётчики)"
FIRESTORE_EXPORT_DIR="$W/export" EXPORT_DIR="$W/export" FIRESTORE_EXPORT_CONFIRM=YES EXPORT_MAX_DOCS=5000 EXPORT_EXCLUDE_COLLECTIONS=push,priv \
  node "$R/tools/firestore-export.js" | grep -E '"total'
echo "== relational"; node "$R/tools/neon-import.js" "$W/export" "$W/out" | node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(JSON.stringify({docs:o.docs,tables:o.tables,conflicts:o.conflicts,skipped:o.skipped}))"
Q -f "$W/out/neon-import.sql" >/dev/null && echo "relational: импорт OK, сверка сошлась"
echo "== fs_docs"; node "$R/tools/neon-import-docs.js" "$W/export" "$W/out"
Q -f "$W/out/fs-docs-import.sql" >/dev/null && echo "fs_docs: импорт OK, сверка сошлась"
Q -F ' ' -c "select 'fs_docs всего', count(*) from fs_docs" -c "select 'fs_docs/'||parent, count(*) from fs_docs where parent !~ '/' group by parent order by parent"
rm -rf "$W/export" "$W/out"
echo "== ГОТОВО"

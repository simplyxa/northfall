#!/usr/bin/env bash
# Полный прогон на ТЕСТОВОЙ базе Neon внутри GitHub Actions (или локально на одноразовой базе):
#   выгрузка Firestore -> импорт -> сверка счётчиков -> smoke пула pg -> конкурентные тесты.
# Данные игроков остаются на раннере и удаляются в конце; в лог попадают только счётчики.
# Нужно: NEON_TEST_DATABASE_URL (direct-адрес тестовой базы), FIREBASE_SERVICE_ACCOUNT (если нет EXPORT_DIR).
# RESET=yes — стереть схему public тестовой базы и накатить миграции заново.
set -euo pipefail
: "${NEON_TEST_DATABASE_URL:?нужен секрет NEON_TEST_DATABASE_URL}"
R="$(cd "$(dirname "$0")/.." && pwd)"; W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
U="$NEON_TEST_DATABASE_URL"
Q() { psql "$U" -v ON_ERROR_STOP=1 -Atq "$@"; }

echo "== подключение"; Q -c "select 'ok', version()" | cut -c1-60
if [ "${RESET:-no}" = "yes" ]; then echo "== RESET: схема public пересоздаётся"; Q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"; fi
if [ "$(Q -c "select to_regclass('public.users') is not null")" != "t" ]; then
  echo "== миграции 0001, 0002"; for f in 0001_initial_hybrid_schema 0002_domain_tables_and_constraints; do Q -f "$R/db/migrations/$f.sql" >/dev/null; done
fi
if [ "$(Q -c "select count(*) from pg_constraint where conname='chk_market_sold_has_buyer'")" = "0" ]; then echo "== миграция 0003"; Q -f "$R/db/migrations/0003_market_sold_requires_buyer.sql" >/dev/null; fi
echo "таблиц в public: $(Q -c "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")"

if [ -z "${EXPORT_DIR:-}" ]; then
  echo "== экспорт Firestore (только счётчики в логе)"
  EXPORT_DIR="$W/export" FIRESTORE_EXPORT_DIR="$W/export" FIRESTORE_EXPORT_CONFIRM=YES EXPORT_MAX_DOCS="${EXPORT_MAX_DOCS:-5000}" EXPORT_EXCLUDE_COLLECTIONS=push,priv \
    node "$R/tools/firestore-export.js" | grep -E '"total' 
  EXPORT_DIR="$W/export"
fi
echo "== генерация SQL"; node "$R/tools/neon-import.js" "$EXPORT_DIR" "$W/out" | node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(JSON.stringify({docs:o.docs,tables:o.tables,conflicts:o.conflicts,skipped:o.skipped}))"
if [ "$(Q -c "select count(*) from users")" != "0" ]; then echo "ОШИБКА: база не пустая. Запусти с reset=yes (только тестовая база!)"; exit 1; fi
echo "== импорт (одна транзакция со сверкой)"; Q -f "$W/out/neon-import.sql" >/dev/null && echo "импорт OK, сверка счётчиков внутри транзакции сошлась"
echo "== счётчики в базе"
Q -F ' ' -c "select 'users',count(*) from users union all select 'characters',count(*) from characters union all select 'wallets',count(*) from wallets union all select 'wallet_transactions',count(*) from wallet_transactions union all select 'market_listings',count(*) from market_listings union all select 'clans',count(*) from clans union all select 'clan_members',count(*) from clan_members union all select 'source_documents',count(*) from migration_source_documents"
rm -rf "$W/export" "$W/out"   # данные игроков удаляем сразу

echo "== smoke пула pg (server/pg.js)"
( cd "$R" && DATABASE_URL="$U" node -e "
const p=require('./server/pg');(async()=>{const r=await p.smoke();console.log(JSON.stringify(r));await p.close();process.exit(r.ok?0:1)})()" )

if command -v pgbench >/dev/null; then
  echo "== конкурентные тесты"; TEST_DATABASE_URL="$U" "$R/db/tests/run-concurrency.sh"
else echo "== pgbench не найден: конкурентные тесты пропущены"; fi
echo "== ГОТОВО"

#!/usr/bin/env bash
# Concurrency tests on a DISPOSABLE PostgreSQL database that already has migrations applied.
# Usage: TEST_DATABASE_URL=postgres://... db/tests/run-concurrency.sh
# Needs psql and pgbench. NEVER point it at production: it inserts t_* rows and deletes them at the end.
set -euo pipefail
: "${TEST_DATABASE_URL:?set TEST_DATABASE_URL to a disposable test database}"
D="$(cd "$(dirname "$0")" && pwd)/concurrency"
Q() { psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -Atq "$@"; }
cleanup() { Q -c "DELETE FROM market_listings WHERE id LIKE 't_L%'; DELETE FROM wallet_transactions WHERE firebase_uid LIKE 't_%'; DELETE FROM wallets WHERE firebase_uid LIKE 't_%'; DELETE FROM users WHERE firebase_uid LIKE 't_%';" >/dev/null || true; }
trap cleanup EXIT
cleanup
Q -c "INSERT INTO users(firebase_uid) VALUES ('t_buyer'),('t_seller');
      INSERT INTO wallets(firebase_uid, premium_gold) VALUES ('t_buyer', 1000), ('t_seller', 0);
      INSERT INTO market_listings(id, seller_uid, item, price) SELECT 't_L'||g, 't_seller', '{}', 100 FROM generate_series(1,40) g;"
fail=0
# 1) duplicate webhook
pgbench -n -c 8 -t 25 -f "$D/webhook.pgb" "$TEST_DATABASE_URL" >/dev/null
g=$(Q -c "SELECT premium_gold FROM wallets WHERE firebase_uid='t_buyer'")
# buyer has 1000 + 500 credit exactly once
[ "$g" = "1500" ] && echo "OK   webhook credited once (1500)" || { echo "FAIL webhook: buyer gold=$g, expected 1500"; fail=1; }
# 2) market race (buyer runs out of money after 15 purchases: CHECK aborts the rest, which is intended)
pgbench -n -c 8 -t 60 -f "$D/market.pgb" "$TEST_DATABASE_URL" >/dev/null 2>&1 || true
sold=$(Q -c "SELECT count(*) FROM market_listings WHERE id LIKE 't_L%' AND status='sold'")
b=$(Q -c "SELECT premium_gold FROM wallets WHERE firebase_uid='t_buyer'")
s=$(Q -c "SELECT premium_gold FROM wallets WHERE firebase_uid='t_seller'")
[ "$((1500 - 100*sold))" = "$b" ] && [ "$((100*sold))" = "$s" ] && [ "$b" -ge 0 ] \
  && echo "OK   market: $sold sold, buyer=$b seller=$s (money conserved, no negative balance)" \
  || { echo "FAIL market: sold=$sold buyer=$b seller=$s"; fail=1; }
# 3) schema guard from 0003
if psql "$TEST_DATABASE_URL" -q -c "INSERT INTO market_listings(id,seller_uid,item,price,status) VALUES ('t_Lx','t_seller','{}',1,'sold')" 2>/dev/null; then
  echo "FAIL sold listing without buyer was accepted (apply 0003)"; fail=1; else echo "OK   sold listing needs a buyer"; fi
exit $fail

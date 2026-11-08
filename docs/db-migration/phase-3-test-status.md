# Phase 3 — migration draft and synthetic test status

## Added files

- `db/migrations/0002_domain_tables_and_constraints.sql` — additive draft for missing domains and supporting indexes.
- `db/tests/0001_0002_integrity_smoke.sql` — synthetic integrity smoke test. It inserts temporary test entities and ends with ROLLBACK.

## What the smoke test covers

- users, characters and JSONB character state;
- wallet balance and ledger idempotency key;
- unique reward claims;
- clan, membership and contributions prerequisites;
- friendship pair uniqueness independent of pair order;
- active market listing;
- raid participant/action uniqueness;
- duel action uniqueness;
- payment and payment-order relation;
- outbox event and notification job inserts;
- rejection of negative wallet balances.

Run against a disposable PostgreSQL database only:

```sh
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0001_initial_hybrid_schema.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0002_domain_tables_and_constraints.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/0001_0002_integrity_smoke.sql
```

The smoke test transaction rolls back its synthetic rows. Use a fresh disposable database; do not point TEST_DATABASE_URL at production.

## Execution status

**Not executed.** The current work environment does not have `psql`, a PostgreSQL server, or Docker available. Therefore this is a prepared test fixture, not a passing test result. No claim is made that PostgreSQL accepted the migrations.

Before any application:
1. provision a disposable PostgreSQL 15+ instance;
2. apply 0001 and 0002 there;
3. run the smoke test with ON_ERROR_STOP;
4. inspect query plans and add concurrency tests;
5. fix any SQL or behavioral issues found;
6. only then discuss a test-environment application.

No production database was contacted or modified. No Firestore reads/export were performed. No application runtime or deployment was changed.

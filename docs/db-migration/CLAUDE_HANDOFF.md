# NORTHFALL — HANDOFF FOR CLAUDE
Updated: 2026-11-09
Branch: `migration/firestore-audit-phase-1`
Repository: `Simplyxa/northfall`
Pull request: https://github.com/Simplyxa/northfall/pull/44

## Purpose

This branch contains the preparation work for moving Northfall's game data from Firebase Firestore to Neon PostgreSQL. Continue the migration only on this branch. The user is pausing migration work with ChatGPT and will work on the game interface separately.

## Verified current state

- The user created a Neon PostgreSQL database named `Northfall-test`.
- The user applied `db/migrations/0001_initial_hybrid_schema.sql` and `db/migrations/0002_domain_tables_and_constraints.sql` in Neon.
- Neon reported successful execution of the second migration.
- The user queried `information_schema.tables` and got **43 public base tables**.
- The user ran `db/tests/0001_0002_integrity_smoke.sql`; Neon showed successful execution of the transaction's statements. The script ends with `ROLLBACK`, so its synthetic fixtures were not retained.
- This confirms the DDL and current synthetic integrity smoke test execute in this test database. It does NOT prove that real player data has been migrated or that game workflows are fully tested.
- No production Neon connection, production database, or production data migration has been made.

## Files in this migration branch

### Inventory and design
- `docs/db-migration/phase-1-firestore-inventory.md`
- `docs/db-migration/phase-2-field-mapping.md`
- `docs/db-migration/phase-2a-read-path-audit.md`
- `docs/db-migration/phase-2b-api-contracts.md`
- `docs/db-migration/phase-3-schema-review.md`
- `docs/db-migration/phase-3-test-status.md`
- `docs/db-migration/phase-4-node-connection-preparation.md`

### SQL
- `db/migrations/0001_initial_hybrid_schema.sql`
- `db/migrations/0002_domain_tables_and_constraints.sql`
- `db/tests/0001_0002_integrity_smoke.sql`

### Export preparation
- `tools/FIRESTORE_EXPORT_README.md`
- `tools/firestore-export.js` — prepared but NOT RUN.

## Migration architecture decisions

1. Firebase Authentication remains the identity provider initially.
2. PostgreSQL/Neon will gradually replace Firestore as the game-data store.
3. Preserve Firebase UID and source Firestore document IDs during import.
4. Keep evolving character payloads such as inventory/equipment/state in JSONB initially; normalize later only after the actual fields and invariants are verified.
5. Economy, item transfer, marketplace, clan contributions, combat rewards, daily claims and Xsolla credits must be transactional and idempotent.
6. Use an explicit feature flag / bounded domain rollout. Do not enable dual writes or change production read paths as an unreviewed shortcut.
7. The Neon test database is isolated test infrastructure. Never configure the live Fly app to use its URL.
8. Use Neon pooled connection URL for the long-running Fly app; direct URL for one-off migrations. Keep credentials in Fly secrets, never in Git or chat.

## Critical safety constraints

- Firestore quota was reported at approximately **93.5%**. Do NOT run the recursive exporter, Firestore tests, broad Firestore scans, or exploratory production reads without the user's explicit informed approval or after quota reset.
- `tools/firestore-export.js` has not been run.
- Do not merge PR #44 or deploy this branch without explicit user approval.
- Do not change the live Fly deployment, production environment variables, Firebase config, or active game data routes.
- Do not switch player saves, wallets, payments, combat, market, clans, social features or WebSocket feeds to PostgreSQL yet.
- The user has approved a maintenance notice for the eventual final cutover only. This is NOT approval to perform cutover now.
- Never put the Neon connection string in a commit, issue, log, screenshot or chat message.

## Static audit findings worth preserving

Potential Firestore read-heavy paths identified by source review (not measured live attribution):
- WebSocket hub feed `raidq` is unbounded.
- Admin live-ranking diagnostic can scan up to 1,500 saves and matching player profiles.
- Startup test-card cleanup performs a full players scan.
- Scheduled push cohort queries.
- Active server-side Firestore listeners.

These are potential sources only; do not claim any one path caused the reported quota usage.

The audit covered:
- Browser listeners/reads in `public/index.html` and `public/en/index.html`.
- WebSocket feeds in `server/hub.js`.
- Core modules `server/raid.js`, `server/duel.js`, `server/cycle.js`, `server/apvp.js`.
- Save and economy routes in `server/saves.js` and `server/index.js`.
- Netlify handlers: account, gold, push, push-cron, track, Xsolla token/webhook, deploy-succeeded.
- Important transactional/idempotency requirements for payment webhooks, reward claims, market purchase, item transfer and combat settlement.

## Exact next steps for Claude

### Step 1 — review, do not rush to production
- Review the two SQL migrations and smoke test against the current Neon test database.
- Check foreign keys, uniqueness, nullability, JSONB constraints and index suitability.
- Add further synthetic-only tests for concurrency/idempotency (market double-purchase, duplicate Xsolla webhook credit, duplicate reward claim, repeated duel/raid settlement).
- Keep all tests on `Northfall-test`; no Firestore reads required.

### Step 2 — isolated Node.js connection
- Add `pg` to `package.json` and update lockfile.
- Add a lazy PostgreSQL pool module, enabled only when `DATABASE_URL` exists.
- Start with a small pool (about 3 connections) appropriate for current Fly machine (256 MB).
- Require TLS; never disable certificate verification.
- Add a staging-only `SELECT 1` smoke test and graceful pool shutdown.
- Keep `/healthz` as process liveness; do not make the game restart solely because Neon is temporarily unavailable.
- Do not route game operations through PostgreSQL in this step.
- Do not add the test URL to the production Fly app.

### Step 3 — plan one domain at a time
Before any production migration, define an import plan, reconciliation report, rollback plan, monitoring, and user-approved maintenance window. Start with a low-risk read-only domain only after staging validation. Treat wallets, payments, inventory, marketplace and combat as high-risk transactional domains.

## Current stop point

The database schema has been applied successfully to the Neon test database, the 43-table count has been verified, and the synthetic rollback smoke test has executed successfully. The next engineering task is SQL/concurrency review and then an isolated Node.js `pg` connection smoke test — not production cutover.

## User's parallel work

The user and ChatGPT will now work on Northfall's interface. Keep UI work separate from this migration branch unless the user explicitly asks to combine them.

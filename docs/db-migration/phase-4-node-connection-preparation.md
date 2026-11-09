# Phase 4 — Node.js / Neon connection preparation

Status: preparation only. No production connection is enabled.

## Current runtime (source review)

- Fly app: `northfall`, primary region `fra`, Node.js 20.
- Container currently installs `firebase-admin` and `web-push`; PostgreSQL driver `pg` is not yet a dependency.
- `server/index.js` starts the HTTP server and uses Firebase Admin for save operations, WebSocket feeds, scheduled push work, and other existing handlers.
- Firebase Auth and Firestore remain the active identity/data path.
- Fly health check currently calls `GET /healthz`.
- Fly machine is configured as `shared-cpu-1x`, 256 MB RAM. A PostgreSQL pool must therefore be kept small.

## Safe connection design

1. Add the Node.js `pg` driver in a separate code change and lockfile update.
2. Create an isolated PostgreSQL pool module. It must be lazy: no connection attempt unless `DATABASE_URL` is explicitly set.
3. Use Neon’s pooled connection string for the long-running app runtime (the hostname contains `-pooler`). Keep the direct connection string for one-off migrations/admin work.
4. Require TLS. Do not disable certificate verification.
5. Start with a small pool (`max: 3`, `idleTimeoutMillis: 10000`, `connectionTimeoutMillis: 5000`) to fit the current 256 MB Fly machine. Revisit only after measuring memory and concurrent DB demand.
6. Store `DATABASE_URL` as a Fly secret, never in `fly.toml`, source code, GitHub, client JavaScript, or logs.
7. Add a separate, admin-protected or internal-only DB diagnostic. Do not make a public endpoint that reveals connection details, schema, or query errors.
8. Keep `/healthz` as process liveness. Do not make the Fly health check depend on Neon during the first integration stage; otherwise a temporary DB outage could restart or remove the game server.
9. Preserve Firebase Auth. Migrate one bounded read/write domain at a time behind an explicit feature flag; do not dual-write production data as an unreviewed shortcut.

## Required first connection test (staging only)

After the driver and isolated pool module are added, test from a staging process with a staging-only Neon pooled URL:

- `SELECT 1 AS ok`
- Read-only schema inventory from `information_schema.tables`.
- Verify the expected 43 public tables.
- Confirm graceful pool shutdown on process termination.
- Confirm the app still starts and serves the game when `DATABASE_URL` is absent.

No game routes should read or write PostgreSQL in this connection smoke-test change.

## Important separation

- Neon project `Northfall-test` is a test database, not the live game database.
- The direct URL shown in Neon’s Connect dialog is a credential. Do not paste it into chat or commit it.
- The current production Fly app must not receive the test database URL.
- Do not export or read Firestore for this phase; Firestore quota remains protected.
- Do not merge the migration PR or switch production without a separate review and explicit approval.

## Review findings / open work

- `pg` is not currently present in `package.json` or the lockfile.
- No PostgreSQL module exists in the current server runtime.
- The current server still relies on Firebase for saves and WebSocket data.
- The SQL schema and smoke test have been applied/run manually in Neon by the project owner; this proves the DDL and current synthetic integrity test execute in that test database, not that production data has been migrated or all game flows are validated.

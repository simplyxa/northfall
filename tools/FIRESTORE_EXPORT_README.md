# Firestore export dry-run

This utility is a **read-only** exporter for the Northfall migration. It does not write to Firestore and does not connect to PostgreSQL.

## Before running

- Use a Firebase service account with read-only access if possible.
- Never commit the service-account JSON or exported data to GitHub.
- A full export reads every document in every discovered collection/subcollection and can incur Firestore document-read charges.
- Exporting while players are active is not a consistent point-in-time snapshot. It is for inventory and dry-run validation only.
- Set a conservative `EXPORT_MAX_DOCS` first. Increase it only after checking the first run's manifest and Firebase usage.
- Store output in a private local directory and protect it as production player data.

## Run

From the repository root, with Node.js 20+ and dependencies installed:

```bash
FIRESTORE_EXPORT_CONFIRM=YES \
FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}' \
EXPORT_MAX_DOCS=1000 \
EXPORT_PAGE_SIZE=100 \
FIRESTORE_EXPORT_DIR=./private-firestore-export \
node tools/firestore-export.js
```

Prefer supplying `FIREBASE_SERVICE_ACCOUNT` through a local environment variable or secret manager instead of putting the JSON directly in shell history.

The script stops if `FIRESTORE_EXPORT_CONFIRM` is not exactly `YES`. It also stops when `EXPORT_MAX_DOCS` is reached. The output contains JSONL files for each discovered collection path and a `manifest.json` with document counts.

## What this does not do

- No Firestore writes, deletes, or security-rule changes.
- No PostgreSQL connection or import.
- No automatic migration/cutover.
- No guarantee of a consistent snapshot during live gameplay.
- No sanitization of personal data; exported files must be treated as confidential.

After a small test export, review the manifest and document shapes before planning a production export.

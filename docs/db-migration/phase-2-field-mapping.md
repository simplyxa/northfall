# Northfall PostgreSQL field mapping — Phase 2 (draft)

Status: code-derived mapping; pending verification against representative Firestore exports.  
Source branch: current `main` application code.  
No production database or game runtime was modified.

## 1. Mapping principles

- Keep Firebase Auth as the identity provider initially; `users.id` is the Firebase UID.
- Use relational columns for ownership, balances, statuses, counters, timestamps and values used in joins/sorting.
- Preserve evolving game payloads in JSONB until their internal schema is fully documented.
- Do not infer a field as authoritative just because the browser sends it. Server validation and existing transaction logic determine the authoritative source.
- Keep original Firestore document IDs in `source_document_id` during migration for traceability and rollback.

## 2. Confirmed fields from server code

### `saves/{uid}` → `characters` + `character_state`

Observed/used fields in server code:

| Field | Proposed destination | Notes |
|---|---|---|
| document ID | `characters.user_id` | Firebase UID; unique. |
| `name` | `characters.name` | Character display name; also used for name lookup. |
| `lvl` | `characters.level` | Numeric level, used for rankings and eligibility. |
| `clan` | `characters.clan_id` | Clan membership mirror; canonical membership should be `clan_members`. |
| `ts` | `character_state.saved_at` | Save timestamp used by stale-save guard. |
| `inv` | `character_state.state->'inv'` | Must be an array; item instances retain their current shape initially. |
| `eq` | `character_state.state->'eq'` | Equipment map; contributes to public stat sum. |
| `st` | `character_state.state->'st'` | Base characteristics. |
| `gold`, `iron` | `character_state.state` initially | Regular resources; later promote to relational resource balances if economy operations need central ledgering. |
| `au` | Do not treat as authoritative in saves | Premium gold is held in `wallet/{uid}.au`; save copy is legacy/fallback only. |
| `rating`, `srat`, `win`, `lose`, `sid`, `psid`, `psrat`, `dr`, `dn`, `dw` | `player_profiles` / `player_ratings` | Server computes public ranking card and updates it with save transactions. |
| `_aw` | JSONB in character state | Pending raid reward bundle (gold/iron/etc. and XP); claim flow must be inspected before finalizing. |
| `_pubStats`, `_ar`, `_tp`, `wp`, `wclaim`, `wbcl` | JSONB initially / normalized later | Internal server bookkeeping, arena/world-boss/clan-war state. |

Validation observed: `inv` must be an array; save payload must be an object; if `acc` exists it must equal authenticated UID. A stale-save guard runs inside a Firestore transaction before writing.

### `players/{uid}` → `player_profiles`

Observed fields written by server:
- `lvl`, `ssum`, `rating`, `srat`, `win`, `lose`, `sid`, `psid`, `psrat`, `dr`, `dn`, `dw`, `seen`.
- Additional ranking/war fields may be written by duel logic: `wp`.

This is a public/read-optimized projection, not the canonical character save. It is read in bulk by the WebSocket hub (up to 300 records) and ranking/admin paths. Plan a profile projection table with indexed ranking columns and a JSONB `extra` for fields not yet normalized.

### `wallet/{uid}` → `wallets` + `wallet_transactions`

Observed fields:
- `au`: authoritative premium-gold balance.
- `created`: wallet creation timestamp.
- `xd`, `xn`: daily silver-to-gold exchange day and amount.
- `gp`: pending admin gifts keyed by gift ID.
- `bd`, `bc`: boss reward day and per-boss daily claim counters.
- `gs`, `pwa`, `dsc`, `fw`: one-time/recurring reward markers.
- `log/{id}`: operation, amount, reason, timestamp, references.
- `claims/{key}`: idempotency records for boss/raid/world-boss reward claims.

Proposed columns:
`user_id PK`, `gold BIGINT NOT NULL CHECK(gold >= 0)`, `exchange_day`, `exchange_amount`, `boss_claim_day`, `boss_claim_counts JSONB`, `reward_markers JSONB`, `pending_gifts JSONB`, `created_at`, `updated_at`.

The transaction ledger is append-only and needs a unique idempotency/reference key. Do not use a random timestamp-only ID as the new primary key.

### `market/{listingId}` → `market_listings`

Confirmed fields:
- `seller`, `sname`, `item`, `price`, `au`, `ts`, `sold`, `srv`.
- Purchase adds `buyer`, `bname`, `paid`.

Proposed columns:
`id`, `seller_user_id`, `buyer_user_id nullable`, `item_payload JSONB`, `price BIGINT`, `currency`, `status`, `created_at`, `sold_at`, `source_document_id`.

Important: market listing creation removes the item from the seller save in the same Firestore transaction. Purchase updates buyer/seller wallets and listing state in one transaction. PostgreSQL implementation must use one SQL transaction and lock the listing row (`SELECT ... FOR UPDATE`).

### `dm/{pairId}/m/{messageId}` → `direct_messages`

Confirmed fields for item-mail operation:
- `from`, `name`, `text`, `ts`, `item`, `claimed`, `paid`, `srv`, and later `claimedTs`.

Proposed columns: message ID, pair ID, sender UID, created timestamp, text, optional item JSONB, claimed flag/time, paid marker, extra JSONB.

Claiming an attached item must atomically set `claimed=true` and insert the item into the recipient inventory state.

### `clans/{clanId}/dep/{uid}` → `clan_contributions`

Confirmed fields:
- `name`, `gold`, `iron`.
- Special document ID `quest` stores clan quest deposit/progression data.
- Clan document itself is also updated with `xp`, `wq`, `b`, `spent` in cycle logic.

Do not migrate every `dep` document blindly into member contributions: branch on document ID and shape. Proposed separate `clan_contributions` and `clan_progress` tables.

### `raids/{raidId}` and `raids/{raidId}/a/{uid}`

Code confirms:
- Raid/duel parent document contains `type`, `st`, `r`, `dl`, `mem`, and activity-specific state such as `hp`, `wv`, `mobs`, `go`, `bon`, `sw`, `log`, `b`, `awarded`, `scored`, `res`.
- Action child documents contain round `r` and action `a`.

Proposed: `raid_instances` relational metadata + `state JSONB`; `raid_participants` (raid_id, user_id, participant JSONB); `raid_actions` (raid_id, user_id, round, action JSONB, unique(raid_id,user_id,round)).

Awarding a raid reward must be idempotent. Use a unique reward key such as (raid_id, user_id, reward_type) and credit the wallet/resource ledger in the same transaction.

### `wars/{warId}` → `clan_wars`

Observed fields include `a`, `b`, `end`, `ts`, `w`. `w` is a per-clan score map. Proposed relational columns for clan IDs/times/status and JSONB score map initially; normalize per-side scores into `clan_war_scores` if queries need it.

### `world/{documentId}` → `world_events` / `world_boss_state`

Observed world-boss state is keyed by day (`b{day}`) and includes `killed`, `dmg` and other boss state fields. Other world docs use `day` for ordering. Classify document IDs and payloads before migration; do not assume all `world` docs are the same type.

### `clans/{clanId}` → `clans`

Observed fields include `name`, `leader`, `mem`/ `members`, `xp`, `wq`, `b`, `spent`. Some fields are duplicated in player save/profile documents. Canonical membership should be a normalized `clan_members` relation; preserve legacy arrays in source JSON for reconciliation only.

## 3. Query and index requirements

| Use case | PostgreSQL index |
|---|---|
| Load a player by Firebase UID | unique index on `characters.user_id` |
| Search exact normalized character name | unique index on `character_names.normalized_name` |
| Leaderboards | composite indexes on profile/rating columns (level, rating, stat sum, season rating) |
| Active market browse | partial index where status = 'active', ordered by created_at/price |
| Seller's listings | (seller_user_id, status, created_at DESC) |
| Wallet ledger | (user_id, created_at DESC) and unique idempotency key |
| Clan membership | unique (user_id), plus (clan_id, role) |
| Clan activity | (clan_id, created_at DESC) |
| Chat and DM history | (channel_or_pair_id, created_at DESC) |
| Raid actions | unique (raid_id, user_id, round) |
| Active wars | index on status/end_at |
| Reward claims | unique (user_id, source_type, source_id, reward_type) |
| Payments | unique Xsolla order ID / external transaction ID |

## 4. Transaction requirements to preserve

1. Character save: optimistic concurrency/version check; reject stale save; write character state and public profile projection atomically.
2. Market listing: remove item from inventory and create listing atomically.
3. Market purchase: lock listing; verify status and buyer balance; debit buyer, credit seller, transfer item and mark listing sold atomically.
4. Item mail: debit sender fee, remove item and create message atomically.
5. Item claim: lock message, ensure unclaimed and recipient is valid, add item and mark claimed atomically.
6. Clan donation: debit character resource and credit member contribution/clan treasury atomically.
7. Wallet operations: update balance and append ledger row atomically with idempotency key.
8. Xsolla webhook: verify signature; deduplicate by order ID; write payment, wallet credit and ledger event in one transaction.
9. Raid/boss rewards: lock reward claim key and credit reward once only.
10. Duel result: score the match once, update both participants and any active clan war score atomically.

## 5. Open questions before final schema

- Export representative documents from Firebase for `saves`, `players`, `wallet`, `market`, `clans`, `raids`, `wars`, `world`, `dm`, `forum`, `chat`, `stats`, `priv`.
- Confirm whether a Firebase UID can own more than one character (code currently uses one save document per UID).
- Confirm actual save payload version(s) and whether older save formats remain in use.
- Confirm if `gold`/ `iron` are only in character save or also mirrored elsewhere.
- Inspect all Firestore client-side reads/writes and WebSocket fallback feeds before defining final API routes.
- Confirm Xsolla external order ID uniqueness and any historical duplicate/canceled order patterns.
- Confirm retention/moderation requirements for chat, DMs and forum.
- Determine actual document counts and peak write rates from Firebase console; code inspection cannot establish production data volume.

## 6. Phase 3 deliverable

After document samples and query inventory are verified, prepare the first executable `schema.sql` with constraints and indexes, plus a read-only export/dry-run importer. No production writes or cutover in Phase 3.

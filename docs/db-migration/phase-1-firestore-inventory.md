# Northfall database migration — Phase 1: Firestore inventory

Status: preliminary code audit  
Target architecture: Fly.io Node.js API + PostgreSQL (hybrid relational/JSONB)  
Authentication: Firebase Auth remains in place during the migration.

## Scope and safety

This document records Firestore paths found in the current application code. It is an inventory of code references, not a guarantee that every live document or historical collection has been discovered. Before any production migration, compare this inventory with the Firebase console/export and verify document counts.

No production data is changed by this phase. Do not disable Firestore, alter security rules, or switch clients to PostgreSQL as part of this audit.

## Discovered Firestore paths

| Firestore path | Proposed PostgreSQL destination | Notes |
|---|---|---|
| `saves/{uid}` | `characters` + `character_state` | Main character save. Preserve original JSON payload in JSONB initially; add explicit columns for indexed fields. |
| `players/{uid}` | `player_profiles` | Public profile, leaderboard and presence summary. |
| `names/{normalizedName}` | `character_names` | Unique normalized name reservation; preserve UID mapping and timestamps. |
| `priv/{id}` | `account_private` / `system_settings` | Mixed account-private and service/admin state; classify each document before migration. |
| `wallet/{uid}` | `wallets` | Premium currency and wallet state. |
| `wallet/{uid}/log/{id}` | `wallet_transactions` | Append-only transaction ledger. |
| `wallet/{uid}/claims/{id}` | `reward_claims` | Idempotency/claim records; retain unique source keys. |
| `market/{listingId}` | `market_listings` | Listing state and item payload; purchase must be transactional. |
| `clans/{clanId}` | `clans` | Clan metadata and settings. |
| `clans/{clanId}/dep/{docId}` | `clan_contributions` / `clan_progress` | Includes per-member deposits and special quest/progression documents; classify by document ID and shape. |
| `clans/{clanId}/log/{id}` | `clan_activity` | Append-only activity history. |
| `friends/{pairId}` | `friendships` | Pair relationship, status, unread markers and last-message preview. |
| `dmi/{uid}/c/{otherUid}` | `mail_index` | Per-user conversation index and read state. |
| `dm/{pairId}/m/{messageId}` | `direct_messages` | Message history; item attachments and claim state need JSONB/explicit fields. |
| `forum/{topicId}` | `forum_topics` | Topic metadata, counters and moderation flags. |
| `forum/{topicId}/posts/{postId}` | `forum_posts` | Topic posts and replies. |
| `chat/{messageId}` | `chat_messages` | Global/system chat messages. |
| `raids/{raidId}` | `raid_instances` | Shared raid/duel state; preserve atomic update semantics. |
| `raids/{raidId}/a/{uid}` | `raid_actions` | Per-player actions for a round. |
| `raidq/{queueId}` | `raid_queue` | Duel queue/challenge state. |
| `wars/{warId}` | `clan_wars` | Active war state and results. |
| `world/{documentId}` | `world_events` / `world_boss_state` | Includes daily boss state and world-cycle documents; classify by ID and shape. |
| `terr/{territoryId}` | `territories` | Territory ownership/state. |
| `refs/{refId}/got/{uid}` | `referral_rewards` | Reward eligibility and paid/claimed state. |
| `payments/{orderId}` | `payments` | Xsolla order/payment event state; idempotent processing required. |
| `pay/{uid}/orders/{orderId}` | `payment_orders` | Per-user payment/order history. |
| `push/{uid}` | `push_subscriptions` | Push endpoint and scheduling fields. |
| `stats/{day}` | `daily_statistics` | Aggregated counters, including nested/encoded metric keys. |
| `flags/{id}` | `security_flags` | Security/admin review records. |
| `admin/{key}` | `game_settings` | Includes promotional configuration. |

## Code locations checked

- `server/saves.js`: character save operations, market listing/cancel, item transfer, DM item claims, clan deposits, security flags.
- `server/hub.js`: shared realtime feeds for players, clans, wars and world state.
- `server/duel.js`, `server/raid.js`, `server/apvp.js`, `server/cycle.js`: battle, raid, PvP, clan war and world-cycle state.
- `server/index.js`: server API routes that read clan/player/save data.
- `netlify/functions/gold.js`: wallet, market purchases, reward claims and currency operations.
- `netlify/functions/xsolla-token.js`, `netlify/functions/xsolla-webhook.js`: payment order creation and webhook crediting.
- `netlify/functions/account.js`: account-private data and name lookup.
- `netlify/functions/push.js`, `netlify/functions/push-cron.js`, `netlify/lib/push.js`: push subscription and scheduled notifications.
- `netlify/functions/track.js`, `tools/funnel.js`: analytics and operational statistics.
- `netlify/functions/deploy-succeeded.js`: automated forum/chat release announcements.
- `public/index.html` and `public/en/index.html`: direct Firestore access remains in the browser.

## Important migration risks

1. **Browser still accesses Firestore directly.** Examples include character save fallback, name reservation, market, friends, chat, forum, world boss, raids/duels, clan logs and payment history. Moving only server code is insufficient.
2. **Realtime fallback exists.** The client uses the server hub/WebSocket for some feeds and falls back to Firestore subscriptions when the hub is unavailable. A PostgreSQL migration must replace both paths or explicitly remove the fallback after API parity is proven.
3. **Economy must be atomic.** Currency changes, item transfer, market purchases, reward claims and Xsolla webhooks require database transactions, row locking and idempotency keys.
4. **Mixed-purpose documents exist.** `priv`, `world`, and `clans/{id}/dep` contain different document shapes. They must be classified by actual document samples before choosing final columns.
5. **Identity remains Firebase Auth initially.** PostgreSQL users should reference the Firebase UID. Passwords are not exported or migrated.
6. **Data migration needs a write freeze or change capture.** A one-time export while players continue writing can lose updates. Use a controlled maintenance window or dual-write/change-log strategy, then verify before cutover.
7. **Backups and rollback are mandatory.** Keep Firestore intact and read-only only after successful cutover verification; do not delete source data during the initial migration.

## Recommended hybrid modeling rules

- Relational columns for identifiers, ownership, balances, status, timestamps, levels, searchable/sortable values and foreign keys.
- JSONB for evolving character state, item payloads and complex combat snapshots where schema changes frequently.
- Append-only relational ledgers for wallet/payment/reward operations.
- Unique constraints for normalized character names, one character per account (if confirmed), active market listing IDs, payment order IDs and idempotency references.
- Explicit indexes for leaderboard order, active market listings, chat/message chronology, clan membership, active raids/wars and push scheduling.
- Avoid storing derived balances only in a JSONB blob. Keep authoritative currency in relational wallet columns and maintain a transaction ledger.

## Next phase

Phase 2 should inspect representative live document shapes and all Firestore query patterns, then produce:
- a field-level Firestore-to-PostgreSQL mapping;
- the first version of `schema.sql`;
- indexes and constraints;
- a read-only export script and a dry-run importer;
- a reconciliation report (document counts, balances, inventory counts, payments and foreign-key coverage).

Do not connect the importer to production writes until the dry-run report is reviewed.

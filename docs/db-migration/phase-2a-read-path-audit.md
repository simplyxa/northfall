# Firestore read-path audit — Phase 2A

Status: static source audit only. No Firestore requests, production writes, deploys, or runtime changes were performed.

## Why this audit exists

Moving browser subscriptions to WebSocket is not sufficient to remove Firestore usage. The current WebSocket hub itself creates Firestore listeners for its feeds. The migration must replace both browser-side Firestore access and server-side Firestore access.

## Confirmed browser-side listeners and reads

Source: `public/index.html` (English page has a parallel implementation in `public/en/index.html`).

| Area | Current access | Lifecycle / scope | Migration target |
|---|---|---|---|
| Character freshness check | `saves/{uid}.get()` | On document visibility change, guarded by local state | `GET /api/character/version` |
| Raid | `raids/{id}` and `raids/{id}/a` listeners | While raid session is active | WebSocket raid state/actions backed by PostgreSQL |
| Duel | duel parent and `a` child listeners | While duel session is active | WebSocket duel state/actions backed by PostgreSQL |
| Market seller lots | `market where seller == uid limit 50` listener | Persistent for logged-in user | `GET /api/market/mine` + change events |
| Market browse | `market orderBy ts desc limit 200` listener | Market tab only | `GET /api/market` + change events |
| Clan log | `clans/{clan}/log orderBy ts desc limit 60` | Clan log view | `GET /api/clans/:id/log` |
| Forum topics | `forum limit 300` listener | Forum tab | `GET /api/forum/topics` + pagination |
| Forum posts | topic first post get + recent 20 listener + older-page reads | Topic view | `GET /api/forum/topics/:id/posts?cursor=...` |
| Friends | Two queries by `a == uid` and `b == uid`, each limit 100 | Logged-in social area | `GET /api/friends` |
| Mail index | `dmi/{uid}/c` listener | Logged-in mail area | `GET /api/mail` |
| Direct messages | `dm/{pair}/m` ordered desc limit 60 | Open conversation | `GET /api/messages/:pair` + WebSocket events |
| Payment orders | `pay/{uid}/orders` limit 300 listener | Logged-in account | `GET /api/payments/orders` |
| Referral rewards | `refs/{uid}/got` limit 200 listener | Logged-in account | `GET /api/referrals/rewards` |
| Clan dungeon | `clans/{clan}/dun` limit 5 listener | Clan dungeon area | `GET /api/clans/:id/dungeon` |
| Clan deposits | `clans/{clan}/dep` limit 100 listener | Clan area | `GET /api/clans/:id/deposits` |
| Clan chat | `clans/{clan}/chat` ordered desc limit 30 listener | Clan chat view | `GET /api/clans/:id/chat` + WebSocket |
| Admin state | `admin` listeners | Admin/global state | Authenticated admin API |
| Player profile fetch | `players/{id}.get()` | On demand | `GET /api/players/:id` |
| Leaderboard | `players` order by rating limit 60 | On demand / refresh throttled | `GET /api/rankings` |
| Admin payment log | `payments` order by ts limit 50 | Admin-only on demand | Admin API |
| Admin bug list | `bugs limit 100` | Admin-only on demand | Admin API |
| Admin statistics | `players limit 3000` | Admin-only on demand | Admin API / aggregate query |
| Wallet | `wallet/{uid}` listener | Logged-in account | `GET /api/wallet` + event |

The list is a code-derived inventory, not a measured runtime read report. Conditional branches and user navigation determine which listeners are active at a given time.

## Server-side Firestore listeners

Source: `server/hub.js`.

| Feed | Firestore query | Notes |
|---|---|---|
| players | `players.limit(300)` | Shared server listener |
| clans | `clans.limit(100)` | Shared server listener |
| wars | `wars.limit(60)` | Shared server listener |
| world | `world.orderBy(day desc).limit(8)` | Shared server listener |
| chat | `chat.orderBy(ts desc).limit(60)` | Shared server listener |
| terr | `terr.limit(10)` | Shared server listener |
| raidq | `raidq` | Unbounded collection listener; review priority |

The hub unsubscribes a feed after five minutes without subscribers. While subscribed, it continues to listen to Firestore independently of the browser count.

## Existing server write paths

Static audit confirms that `server/saves.js` performs Firestore transactions for character saves and several economic actions (market listing, item mail/claim, wallet updates). `netlify/functions/gold.js` handles wallet/economy transactions. Other game modules (`raid.js`, `duel.js`, `cycle.js`, `apvp.js`) also need route-by-route inspection before they can be moved.

## Recommended migration boundary

Introduce a storage/service boundary on the server. Route handlers and WebSocket modules should depend on domain methods rather than Firestore SDK objects. Implement PostgreSQL repositories behind those methods and switch one domain at a time.

Suggested initial service groups:

1. `characterService`: load/save character, profile projection, optimistic version checks.
2. `walletService`: balance, ledger, idempotent claims and payment credit.
3. `marketService`: list, browse, cancel, purchase; all balance/item/listing changes in one SQL transaction.
4. `socialService`: friends, mail, direct messages, chat.
5. `clanService`: membership, treasury, contributions, logs, dungeon.
6. `worldService`: boss, raids, duel, arena, wars, territories.
7. `rankingService`: leaderboard queries and player profile projection.
8. `forumService`: topics and cursor-paginated posts.

## Safe implementation sequence

- [x] Static inventory of major browser listeners and hub feeds.
- [ ] Enumerate every Firestore access in server modules and Netlify functions.
- [ ] Define stable service contracts and response shapes; do not change runtime yet.
- [ ] Add PostgreSQL connection/config validation without connecting to a live database.
- [ ] Implement and test one read-only domain (rankings or public profiles) against a local/test PostgreSQL instance.
- [ ] Migrate writes with transaction parity and idempotency tests.
- [ ] Move WebSocket feeds to PostgreSQL-backed services.
- [ ] Verify parity, then plan a separate maintenance-window cutover.

## Safety constraints

- Do not run the recursive Firestore exporter while quota is near its limit.
- Do not add shadow writes or dual writes to production during preparation.
- Do not deploy a partially migrated service.
- Keep Firebase Auth initially; this audit concerns Firestore data access, not identity migration.
- The maintenance window is for the final cutover only, after staging and reconciliation are ready.

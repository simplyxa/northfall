#!/usr/bin/env node
'use strict';
// Только счётчики документов (агрегирующие запросы count(): примерно 1 чтение на 1000 документов).
// Содержимое документов НЕ читается и не печатается. Нужен для выбора EXPORT_MAX_DOCS перед экспортом.
const admin = require('../netlify/lib/fb');
const TOP = ['saves', 'players', 'wallet', 'priv', 'push', 'bugs', 'names', 'admin', 'clans', 'wars', 'world', 'terr', 'market',
  'forum', 'pay', 'payments', 'friends', 'dm', 'dmi', 'refs', 'raidq', 'raids', 'chat', 'flags', 'stats', 'gifts', 'bans', 'news'];
const GROUPS = ['log', 'claims', 'chat', 'dun', 'dep', 'posts', 'orders', 'got', 'm', 'c', 'a'];
async function main() {
  const db = admin.firestore(), out = { top: {}, groups: {}, total: 0 };
  const names = new Set(TOP);
  try { for (const c of await db.listCollections()) names.add(c.id); } catch (e) {}
  for (const n of [...names].sort()) {
    try { const s = await db.collection(n).count().get(); const k = s.data().count; if (k) { out.top[n] = k; out.total += k; } } catch (e) { out.top[n] = 'ошибка'; }
  }
  for (const g of GROUPS) {
    try { const s = await db.collectionGroup(g).count().get(); const k = s.data().count; if (k) out.groups[g] = k; } catch (e) { out.groups[g] = 'ошибка'; }
  }
  console.log(JSON.stringify(out, null, 2));
}
main().catch(e => { console.error('[firestore-count] ' + (e && e.message || e)); process.exitCode = 1; });

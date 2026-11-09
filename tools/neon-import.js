#!/usr/bin/env node
'use strict';
// Firestore export (JSONL из tools/firestore-export.js) → SQL-файл для Neon.
// Инструмент НИКУДА не подключается: ни к Firestore, ни к PostgreSQL. Он читает файлы и пишет
//   <out>/neon-import.sql   — одна транзакция: проверка пустой базы, вставки, сверка счётчиков;
//   <out>/import-report.json — что куда попало, конфликты и пропущенное.
// Запуск:  node tools/neon-import.js <каталог-экспорта> [каталог-результата]
// Применение (только на согласованном окне и по плану из docs/db-migration/phase-5-cutover-runbook.md):
//   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f <out>/neon-import.sql
// Если есть конфликты (дубли имён и т.п.), SQL не пишется, пока их не разобрали (или --force).
const fs = require('node:fs');
const path = require('node:path');

const IN = process.argv[2];
const OUT = path.resolve(process.argv[3] || 'neon-import-out');
const FORCE = process.argv.includes('--force');
if (!IN || !fs.existsSync(IN)) { console.error('Использование: node tools/neon-import.js <каталог-экспорта> [каталог-результата] [--force]'); process.exit(2); }

// ---------- чтение ----------
const docs = [];
for (const f of fs.readdirSync(IN).filter(x => x.endsWith('.jsonl')).sort()) {
  for (const line of fs.readFileSync(path.join(IN, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && r.path) docs.push(r); } catch (e) { fail('Битая строка в ' + f); }
  }
}
function fail(m) { console.error('ОШИБКА: ' + m); process.exit(1); }

// ---------- помощники ----------
const report = { docs: docs.length, tables: {}, conflicts: [], skipped: [], notes: [] };
const rows = {};          // таблица → массив значений
const T = (t, row) => { (rows[t] = rows[t] || []).push(row); };
const conflict = (kind, info) => report.conflicts.push({ kind, ...info });
const skip = (path, why) => report.skipped.push({ path, why });

const q = s => s === null || s === undefined ? 'NULL' : "'" + String(s).replace(/\u0000/g, '').replace(/'/g, "''") + "'";
const n = v => (v === null || v === undefined || v === '' || !Number.isFinite(+v)) ? 'NULL' : String(Math.trunc(+v));
const n0 = v => Number.isFinite(+v) ? String(Math.trunc(+v)) : '0';
const nn = (v, min) => String(Math.max(min, Number.isFinite(+v) ? Math.trunc(+v) : min));
const ts = v => {
  if (v && typeof v === 'object' && v.__type === 'timestamp') v = v.value;
  if (v === null || v === undefined || v === '') return 'NULL';
  const d = typeof v === 'number' ? new Date(v) : new Date(v);
  return isNaN(d) ? 'NULL' : q(d.toISOString());
};
// символ NUL недопустим в jsonb: убираем его из строк (а не из готового текста — иначе ломается экранирование)
const j = v => q(JSON.stringify(v === undefined ? null : v, (k, x) => typeof x === 'string' ? x.replace(/\u0000/g, '') : x)) + '::jsonb';
const jo = v => j(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const omit = (o, keys) => { const r = {}; for (const k of Object.keys(o || {})) if (!keys.includes(k)) r[k] = o[k]; return r; };
const txt = v => (v === null || v === undefined || v === '') ? 'NULL' : q(v);

// ---------- разбор документов ----------
const users = new Map();                       // uid → true
const addUser = uid => { if (uid && typeof uid === 'string') users.set(uid, true); return uid; };
const chars = new Map(), clans = new Map();   // uid → doc / id → doc
const segs = d => d.path.split('/');
const parentOf = d => segs(d).slice(0, -1).join('/');

for (const d of docs) {
  const s = segs(d), c = s[0], dat = d.data || {};
  if (s.length === 2 && c === 'saves') { addUser(d.id); chars.set(d.id, dat); }
  if (s.length === 2 && c === 'clans') clans.set(d.id, dat);
}

const names = new Map(), clanNames = new Map();
for (const d of docs) {
  const s = segs(d), c = s[0], dat = d.data || {}, id = d.id;
  try {
    if (s.length === 2 && c === 'saves') {
      const name = String(dat.name || '').trim();
      if (!name) { skip(d.path, 'нет имени'); continue; }
      const nl = name.toLowerCase();
      if (names.has(nl)) { conflict('name_duplicate', { name, uids: [names.get(nl), id] }); continue; }
      names.set(nl, id);
      const cid = dat.clan ? String(dat.clan) : null;
      T('characters', [q(id), q(name), q(nl), nn(dat.lvl, 1), txt(cid), q(d.path), ts(dat.cr || d.createTime)]);
      T('character_state', ['(SELECT id FROM characters WHERE firebase_uid=' + q(id) + ')', jo(dat), q(d.path), ts(dat.ts || d.updateTime)]);
    } else if (s.length === 2 && c === 'players') {
      addUser(id);
      T('player_profiles', [q(id), n(dat.lvl), n(dat.ssum), n(dat.rating), n(dat.srat), n(dat.win), n(dat.lose), n(dat.dr), n(dat.dn), n(dat.dw),
        n(dat.sid), n(dat.psid), n(dat.psrat), n(dat.wp), ts(dat.seen), jo(omit(dat, ['lvl', 'ssum', 'rating', 'srat', 'win', 'lose', 'dr', 'dn', 'dw', 'sid', 'psid', 'psrat', 'wp', 'seen'])), q(d.path)]);
    } else if (s.length === 2 && c === 'wallet') {
      addUser(id);
      const mk = {}; for (const k of ['gs', 'pwa', 'dsc', 'fw']) if (dat[k] !== undefined) mk[k] = dat[k];
      T('wallets', [q(id), nn(dat.au, 0), txt(dat.xd), nn(dat.xn, 0), txt(dat.bd), jo(dat.bc), j(mk), jo(dat.gp),
        jo(omit(dat, ['au', 'xd', 'xn', 'bd', 'bc', 'gs', 'pwa', 'dsc', 'fw', 'gp', 'created'])), q(d.path), ts(dat.created || d.createTime)]);
    } else if (s.length === 4 && c === 'wallet' && s[2] === 'log') {
      addUser(s[1]);
      T('wallet_transactions', [q(s[1]), q(dat.op || 'unknown'), n0(dat.n), txt(dat.why), q('firestore_log'), q(d.path), q('fs:' + d.path), jo(omit(dat, ['op', 'n', 'why', 'ts'])), ts(dat.ts || d.createTime)]);
    } else if (s.length === 2 && c === 'market') {
      const seller = addUser(dat.seller), buyer = dat.buyer ? addUser(dat.buyer) : null;
      const price = Math.trunc(+dat.price);
      if (!seller || !(price > 0) || !dat.item) { skip(d.path, 'нет продавца, цены или вещи'); continue; }
      let status = dat.sold ? 'sold' : 'active';
      if (status === 'sold' && !buyer) { status = 'cancelled'; report.notes.push('Проданный лот без покупателя переведён в cancelled: ' + d.path); }
      T('market_listings', [q(id), q(seller), txt(buyer), txt(dat.sname), txt(dat.bname), j(dat.item), String(price), q(dat.au ? 'premium_gold' : 'gold'), q(status),
        dat.au === undefined ? 'NULL' : (dat.au ? 'true' : 'false'), n(dat.srv), q(d.path), ts(dat.ts || d.createTime),
        status === 'sold' ? ts(dat.sold_ts || d.updateTime) : 'NULL', jo(omit(dat, ['seller', 'buyer', 'sname', 'bname', 'item', 'price', 'au', 'sold', 'srv', 'ts']))]);
    } else if (s.length === 2 && c === 'clans') {
      const name = String(dat.name || '').trim();
      if (!name) { skip(d.path, 'нет названия клана'); continue; }
      const nl = name.toLowerCase();
      if (clanNames.has(nl)) { conflict('clan_name_duplicate', { name, ids: [clanNames.get(nl), id] }); continue; }
      clanNames.set(nl, id);
      let leader = dat.leader || null;
      if (leader && !(chars.has(leader) && String(chars.get(leader).clan || '') === id)) {
        report.notes.push('Лидер клана ' + id + ' (' + leader + ') не состоит в нём по сохранению — leader_uid = NULL');
        leader = null;
      }
      if (leader) addUser(leader);
      T('clans', [q(id), q(name), txt(leader), nn(dat.level, 1), n0(dat.xp), jo({ spent: dat.spent, b: dat.b }), jo({ wq: dat.wq }),
        jo(omit(dat, ['name', 'leader', 'xp', 'wq', 'b', 'spent', 'level'])), q(d.path), ts(d.createTime)]);
    }
  } catch (e) { skip(d.path, 'ошибка разбора: ' + e.message); }
}

// участники кланов — по сохранениям (в Firestore состав клана определяется полем saves.clan)
const clanRows = new Set((rows.clans || []).map(r => r[0]));
const leaderOf = new Map((rows.clans || []).map(r => [r[0], r[2]]));
for (const [uid, dat] of chars) {
  if (!names.has(String(dat.name || '').trim().toLowerCase()) || names.get(String(dat.name).trim().toLowerCase()) !== uid) continue;
  const cid = dat.clan ? String(dat.clan) : null;
  if (!cid) continue;
  if (!clanRows.has(q(cid))) { report.notes.push('Игрок ' + uid + ' ссылается на отсутствующий клан ' + cid + ' — членство не создано'); continue; }
  T('clan_members', [q(cid), q(uid), q(leaderOf.get(q(cid)) === q(uid) ? 'leader' : 'member'), '\'{}\'::jsonb']);
}

// ---------- все документы целиком — в migration_source_documents (трассировка и откат) ----------
for (const d of docs) T('migration_source_documents', [q(parentOf(d)), q(d.id), ts(d.updateTime), j(d.data), 'now()']);

// ---------- SQL ----------
const COLS = {
  users: ['firebase_uid'],
  characters: ['firebase_uid', 'name', 'normalized_name', 'level', 'clan_id', 'source_document_id', 'created_at'],
  character_state: ['character_id', 'state', 'source_document_id', 'source_updated_at'],
  player_profiles: ['firebase_uid', 'level', 'stat_sum', 'rating', 'season_rating', 'wins', 'losses', 'duel_rating', 'duel_count', 'duel_wins', 'season_id', 'previous_season_id', 'previous_season_rating', 'clan_war_points', 'seen_at', 'extra', 'source_document_id'],
  wallets: ['firebase_uid', 'premium_gold', 'exchange_day', 'exchange_amount', 'boss_claim_day', 'boss_claim_counts', 'reward_markers', 'pending_gifts', 'extra', 'source_document_id', 'created_at'],
  wallet_transactions: ['firebase_uid', 'operation', 'amount', 'reason', 'reference_type', 'reference_id', 'idempotency_key', 'metadata', 'created_at'],
  market_listings: ['id', 'seller_uid', 'buyer_uid', 'seller_name', 'buyer_name', 'item', 'price', 'currency', 'status', 'legacy_au', 'legacy_srv', 'source_document_id', 'created_at', 'sold_at', 'extra'],
  clans: ['id', 'name', 'leader_uid', 'level', 'experience', 'treasury', 'progress', 'extra', 'source_document_id', 'created_at'],
  clan_members: ['clan_id', 'firebase_uid', 'role', 'member_data'],
  migration_source_documents: ['source_path', 'source_document_id', 'source_update_time', 'payload', 'imported_at']
};
for (const u of users.keys()) T('users', [q(u)]);
// порядок вставки учитывает внешние ключи; clans ↔ clan_members связаны отложенным ключом
const ORDER = ['users', 'characters', 'character_state', 'player_profiles', 'wallets', 'wallet_transactions', 'market_listings', 'clans', 'clan_members', 'migration_source_documents'];

const sql = [];
sql.push('-- Сгенерировано tools/neon-import.js. Применять только к ПУСТОЙ базе с миграциями 0001-0003.', 'BEGIN;',
  "DO $$ BEGIN IF EXISTS (SELECT 1 FROM users) OR EXISTS (SELECT 1 FROM characters) THEN RAISE EXCEPTION 'База не пустая: импорт остановлен'; END IF; END $$;",
  'SET CONSTRAINTS ALL DEFERRED;');
const expect = {};
for (const t of ORDER) {
  const r = rows[t] || []; expect[t] = r.length; report.tables[t] = r.length;
  for (let i = 0; i < r.length; i += 200) {
    sql.push('INSERT INTO ' + t + ' (' + COLS[t].join(',') + ') VALUES\n' + r.slice(i, i + 200).map(x => '(' + x.join(',') + ')').join(',\n') + ';');
  }
}
sql.push('-- сверка: число строк в базе должно совпасть с ожидаемым (иначе вся транзакция откатится)');
sql.push('DO $$ BEGIN');
for (const t of ORDER) sql.push("  IF (SELECT count(*) FROM " + t + ") <> " + expect[t] + " THEN RAISE EXCEPTION 'Сверка не сошлась: " + t + " ожидалось " + expect[t] + "'; END IF;");
sql.push('END $$;', 'COMMIT;', '');

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'import-report.json'), JSON.stringify(report, null, 2));
if (report.conflicts.length && !FORCE) {
  console.error('Найдено конфликтов: ' + report.conflicts.length + '. SQL не записан. Смотри ' + path.join(OUT, 'import-report.json') + ' (или --force, чтобы пропустить конфликтные записи).');
  process.exit(3);
}
fs.writeFileSync(path.join(OUT, 'neon-import.sql'), sql.join('\n'));
console.log(JSON.stringify({ out: OUT, docs: docs.length, tables: report.tables, conflicts: report.conflicts.length, skipped: report.skipped.length, notes: report.notes.length }, null, 2));

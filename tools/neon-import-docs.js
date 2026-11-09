#!/usr/bin/env node
'use strict';
// Выгрузка Firestore (JSONL) -> SQL для таблицы fs_docs (документное хранилище server/pgdocs.js).
// Никуда не подключается. Пишет <out>/fs-docs-import.sql: проверка пустой таблицы, вставки, сверка счётчика — одна транзакция.
// node tools/neon-import-docs.js <каталог-экспорта> [каталог-результата]
const fs = require('node:fs'), path = require('node:path');
const IN = process.argv[2], OUT = path.resolve(process.argv[3] || 'neon-import-out');
if (!IN || !fs.existsSync(IN)) { console.error('Использование: node tools/neon-import-docs.js <каталог-экспорта> [каталог-результата]'); process.exit(2); }
const q = s => "'" + String(s).replace(/\u0000/g, '').replace(/'/g, "''") + "'";
// типы Firestore из выгрузки: timestamp -> миллисекунды (как их хранит игра), остальное оставляем как есть
const dec = v => {
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === 'object') {
    if (v.__type === 'timestamp') return Date.parse(v.value);
    if (v.__type === 'bytes-base64' || v.__type === 'geopoint' || v.__type === 'document-reference') return v;
    const o = {}; for (const k of Object.keys(v)) o[k] = dec(v[k]); return o;
  }
  return v;
};
const rep = (k, x) => typeof x === 'string' ? x.replace(/\u0000/g, '') : x;
const rows = [], seen = new Set();
for (const f of fs.readdirSync(IN).filter(x => x.endsWith('.jsonl')).sort()) {
  for (const line of fs.readFileSync(path.join(IN, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const d = JSON.parse(line), s = d.path.split('/');
    if (s.length % 2 !== 0 || seen.has(d.path)) continue;
    seen.add(d.path);
    const data = dec(d.data || {});
    rows.push('(' + [q(d.path), q(s.slice(0, -1).join('/')), q(s[s.length - 2]), q(s[s.length - 1]), q(JSON.stringify(data, rep)) + '::jsonb',
      d.createTime ? q(d.createTime) : 'now()', d.updateTime ? q(d.updateTime) : 'now()'].join(',') + ')');
  }
}
const sql = ['-- Сгенерировано tools/neon-import-docs.js. Только в ПУСТУЮ fs_docs.', 'BEGIN;',
  "DO $$ BEGIN IF EXISTS (SELECT 1 FROM fs_docs) THEN RAISE EXCEPTION 'fs_docs не пуста: импорт остановлен'; END IF; END $$;"];
for (let i = 0; i < rows.length; i += 100) sql.push('INSERT INTO fs_docs (path,parent,coll,id,data,create_time,update_time) VALUES\n' + rows.slice(i, i + 100).join(',\n') + ';');
sql.push("DO $$ BEGIN IF (SELECT count(*) FROM fs_docs) <> " + rows.length + " THEN RAISE EXCEPTION 'Сверка не сошлась: ожидалось " + rows.length + "'; END IF; END $$;", 'COMMIT;', '');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'fs-docs-import.sql'), sql.join('\n'));
console.log(JSON.stringify({ out: OUT, documents: rows.length }));

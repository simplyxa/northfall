// Тест сокет-хаба Northfall. Запуск: node tools/wstest.js
// База Firestore мокается, сервер поднимается локально — внешние сервисы не нужны.
//
// Проверяем главное:
//  1) клиент v2 получает полный снимок при подписке, потом — дельты (upd);
//  2) дельта содержит только изменившиеся документы и удалённые id;
//  3) клиент v1 (старый, без версии в hello) по-прежнему получает полный снимок;
//  4) состояние, собранное клиентом из дельт, совпадает с базой.
'use strict';
const http = require('http');
const assert = require('assert');
const hub = require('../server/hub');

let failed = 0, passed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

// ---------- мок Firestore ----------
function makeDb() {
  const store = new Map();       // коллекция → Map(id → данные)
  const listeners = new Map();   // коллекция → Set(onSnapshot)
  const lastDocs = new Map();    // коллекция → Map(id → данные) на прошлом снимке

  const db = {
    collection(name) {
      if (!store.has(name)) store.set(name, new Map());
      const q = {
        limit: () => q, orderBy: () => q,
        onSnapshot(cb, err) {
          if (!listeners.has(name)) listeners.set(name, new Set());
          listeners.get(name).add(cb);
          // первый снимок — все документы как «added»
          const docs = [...store.get(name).entries()].map(([id, d]) => ({ id, data: () => d }));
          const prev = new Map();
          lastDocs.set(name, prev);
          setImmediate(() => cb({
            docs: docs.map(x => ({ id: x.id, data: () => store.get(name).get(x.id) })),
            docChanges: () => docs.map(x => ({ type: 'added', doc: { id: x.id, data: () => store.get(name).get(x.id) } }))
          }));
          return () => listeners.get(name).delete(cb);
        }
      };
      return q;
    },
    // изменить данные и уведомить слушателей
    put(col, id, data) {
      if (!store.has(col)) store.set(col, new Map());
      const m = store.get(col);
      const old = m.get(id);
      m.set(id, data);
      const prev = lastDocs.get(col) || new Map();
      const ch = old === undefined
        ? { type: 'added', doc: { id, data: () => data } }
        : { type: 'modified', doc: { id, data: () => data } };
      lastDocs.set(col, new Map(m));
      for (const cb of listeners.get(col) || []) cb({
        docs: [...m.entries()].map(([i, d]) => ({ id: i, data: () => d })),
        docChanges: () => [ch]
      });
    },
    del(col, id) {
      const m = store.get(col); if (!m) return;
      m.delete(id);
      lastDocs.set(col, new Map(m));
      const ch = { type: 'removed', doc: { id } };
      for (const cb of listeners.get(col) || []) cb({
        docs: [...m.entries()].map(([i, d]) => ({ id: i, data: () => d })),
        docChanges: () => [ch]
      });
    }
  };
  return db;
}

// ---------- минимальный WS-клиент (тот же протокол, что у игры) ----------
function connect(port, proto) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    const c = { msgs: [], waiters: [], state: null, cursor: 0 };
    ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', g: 'test0001', v: proto })); resolve(c); };
    ws.onerror = e => reject(new Error('ws error'));
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      c.msgs.push(m);
      // повторяем логику клиента игры: собираем состояние из снимков и дельт
      if (m.t === 'snap') { c.state = m.d.slice(); }
      else if (m.t === 'upd' && c.state) {
        const by = new Map(); for (const x of c.state) by.set(x.id, x);
        for (const d of (m.u || [])) by.set(d.id, d);
        for (const id of (m.r || [])) by.delete(id);
        let arr = [...by.values()];
        if (m.o) {
          const pos = new Map(); m.o.forEach((id, i) => pos.set(id, i));
          arr = arr.filter(x => pos.has(x.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
        }
        c.state = arr;
      }
      for (const w of c.waiters.slice()) if (w.f(c, m)) c.waiters.splice(c.waiters.indexOf(w), 1);
    };
    c.send = m => ws.send(JSON.stringify(m));
    // next ждёт следующее сообщение, подходящее под предикат (поток, а не история)
    c.next = (f, ms) => new Promise(res => {
      let done = false;
      const w = { f: (cc, m) => { if (done) return false; const r = f(cc, m); if (r) { done = true; res(r); } return !!r; } };
      c.waiters.push(w);
      for (let i = c.cursor; i < c.msgs.length; i++) if (w.f(c, c.msgs[i])) { c.cursor = i + 1; c.waiters.splice(c.waiters.indexOf(w), 1); break; }
      setTimeout(() => { if (!done) { done = true; res(null); const i = c.waiters.indexOf(w); if (i >= 0) c.waiters.splice(i, 1); } }, ms || 3000);
    });
    c.close = () => ws.close();
  });
}

// ---------- сам тест ----------
(async function () {
  const db = makeDb();
  db.put('players', 'p1', { n: 'A', lv: 1 });
  db.put('players', 'p2', { n: 'B', lv: 2 });

  const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  const HUB = hub(server, () => db, async () => 'tester');
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  console.log('\nNorthfall — тест сокет-хаба (протокол v' + 2 + ')\n');

  const a = await connect(port, 2);
  a.send({ t: 'sub', c: ['players'] });

  const snap = await a.next((c, m) => m.t === 'snap' && m.c === 'players' ? m : null);
  ok('v2: первая подписка отдаёт полный снимок', !!snap);
  ok('v2: снимок содержит обоих игроков', snap && snap.d.length === 2, snap && 'получено ' + (snap.d ? snap.d.length : '?'));

  // --- изменение документа ---
  db.put('players', 'p1', { n: 'A', lv: 3 });
  const up1 = await a.next((c, m) => m.t === 'upd' && m.c === 'players' ? m : null);
  ok('v2: изменение приходит дельтой (upd)', !!up1);
  ok('v2: дельта содержит только изменённый документ', up1 && up1.u.length === 1 && up1.u[0].id === 'p1', up1 && JSON.stringify(up1.u && up1.u.map(x => x.id)));
  ok('v2: в дельте нет удалённых id', up1 && (!up1.r || up1.r.length === 0));
  ok('v2: состояние клиента обновилось', a.state && a.state.find(x => x.id === 'p1').lv === 3);

  // --- добавление документа ---
  db.put('players', 'p3', { n: 'C', lv: 1 });
  const up2 = await a.next((c, m) => m.t === 'upd' && m.c === 'players' && m.u && m.u.some(x => x.id === 'p3') ? m : null);
  ok('v2: новый игрок приходит дельтой', !!up2);
  ok('v2: порядок id пришёл вместе с дельтой', up2 && Array.isArray(up2.o) && up2.o.length === 3);
  ok('v2: состояние клиента содержит 3 игроков', a.state && a.state.length === 3);

  // --- удаление документа ---
  db.del('players', 'p2');
  const up3 = await a.next((c, m) => m.t === 'upd' && m.c === 'players' && m.r && m.r.includes('p2') ? m : null);
  ok('v2: удаление приходит в r', !!up3);
  ok('v2: состояние клиента совпадает с базой', a.state && a.state.length === 2 && !a.state.some(x => x.id === 'p2'));

  // --- старый клиент (v1) ---
  const b = await connect(port, 0);   // без версии → как старый клиент
  b.send({ t: 'sub', c: ['players'] });
  const bsnap = await b.next((c, m) => m.t === 'snap' && m.c === 'players' ? m : null);
  ok('v1: старый клиент получает полный снимок', !!bsnap && bsnap.d.length === 2);
  db.put('players', 'p1', { n: 'A', lv: 9 });
  const bsnap2 = await b.next((c, m) => m.t === 'snap' && m.c === 'players' && m.d.some(x => x.id === 'p1' && x.lv === 9) ? m : null);
  ok('v1: старый клиент получает полный снимок при изменении', !!bsnap2);
  const bnotupd = b.msgs.filter(m => m.t === 'upd').length;
  ok('v1: старый клиент не получает дельт', bnotupd === 0);

  // --- проверка сбора состояния ---
  ok('итог: у v2-клиента столько же игроков, сколько в базе', a.state.length === 2);
  ok('итог: состояния v1 и v2 клиентов совпадают', b.state.length === a.state.length);

  a.close(); b.close();
  await new Promise(r => setTimeout(r, 200));
  server.close();

  console.log('\n  пройдено: ' + passed + ', провалено: ' + failed + '\n');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('\nОШИБКА ТЕСТА:', e); process.exit(1); });

// Сокет-хаб Northfall.
// Сервер один раз слушает «горячие» коллекции Firestore и рассылает их состояние всем игрокам по WebSocket.
// Раньше каждое изменение читал каждый открытый клиент; теперь читает только сервер.
// WebSocket реализован без внешних библиотек (RFC 6455: текстовые кадры, ping/pong, close).
//
// Протокол версионируется. v1 (старые клиенты) получают полный снимок ленты при каждом изменении.
// v2 получает дельту: только изменившиеся документы + список удалённых + порядок id.
// Это в разы сокращает трафик на десятки клиентов (лента игроков — до 300 документов).
'use strict';
const crypto = require('crypto');

// что раздаём: имя → как сервер слушает Firestore (повторяет запросы клиента)
const FEEDS = {
  players: db => db.collection('players').limit(300),
  clans: db => db.collection('clans').limit(100),
  wars: db => db.collection('wars').limit(60),
  world: db => db.collection('world').orderBy('day', 'desc').limit(8),
  chat: db => db.collection('chat').orderBy('ts', 'desc').limit(60),
  terr: db => db.collection('terr').limit(10),
  raidq: db => db.collection('raidq')
};
const IDLE_UNSUB = 5 * 60000; // нет подписчиков 5 минут — сервер перестаёт слушать коллекцию
const MAXMSG = 64 * 1024;
const PROTO = 2;            // текущая версия протокола дельт
const SNAP_MS = 120;        // склейка частых изменений (бой, рейд) в одну рассылку

module.exports = function hub(server, getDb, verify, gate) {
  const clients = new Set();
  const RAID = require('./raid')(getDb);
  const DUEL = require('./duel')(getDb);
  const CYCLE = require('./cycle')(getDb);
  const APVP = require('./apvp')(getDb);
  const feeds = {}; // name → {un, docs, subs:Set, idle, ready}
  // Оценка тарифицируемых чтений живых подписок Firestore с момента запуска процесса.
  // Первый снимок тарифицируется по числу документов; далее — added/modified, без removed.
  const readStats = { since: Date.now(), total: 0, byCollection: {} };
  function countReads(name, n, initial) {
    n = Math.max(0, n | 0); if (!n) return;
    readStats.total += n;
    const x = readStats.byCollection[name] || (readStats.byCollection[name] = { total: 0, initial: 0, updates: 0, lastAt: 0 });
    x.total += n; x[initial ? 'initial' : 'updates'] += n; x.lastAt = Date.now();
  }

  // ---------- WebSocket ----------
  server.on('upgrade', (req, sock) => {
    let u; try { u = new URL(req.url, 'http://x'); } catch (e) { return sock.destroy(); }
    const key = req.headers['sec-websocket-key'];
    if (process.env.MAINT === '1') { sock.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return sock.destroy(); }
    if (u.pathname !== '/ws' || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      sock.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return sock.destroy();
    }
    const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
    sock.setNoDelay(true);
    const c = { sock, buf: Buffer.alloc(0), subs: new Set(), uid: '', gid: '', alive: true, open: true, t0: Date.now(), v: 0, msgQueue: Promise.resolve() };
    clients.add(c);
    sock.on('data', d => onData(c, d));
    sock.on('close', () => drop(c));
    sock.on('error', () => drop(c));
    send(c, { t: 'hi', v: 1 });
  });

  function frame(op, payload) {
    const n = payload.length; let h;
    if (n < 126) { h = Buffer.alloc(2); h[1] = n; }
    else if (n < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
    h[0] = 0x80 | op;
    return Buffer.concat([h, payload]);
  }
  function sendRaw(c, buf) { if (c.open) try { c.sock.write(buf); } catch (e) { drop(c); } }
  function send(c, obj) { sendRaw(c, frame(1, Buffer.from(JSON.stringify(obj)))); }

  function onData(c, d) {
    c.buf = Buffer.concat([c.buf, d]);
    while (c.buf.length >= 2) {
      const b0 = c.buf[0], b1 = c.buf[1], op = b0 & 15, masked = b1 & 128;
      let n = b1 & 127, off = 2;
      if (n === 126) { if (c.buf.length < 4) return; n = c.buf.readUInt16BE(2); off = 4; }
      else if (n === 127) { if (c.buf.length < 10) return; n = Number(c.buf.readBigUInt64BE(2)); off = 10; }
      if (n > MAXMSG) return drop(c);
      const need = off + (masked ? 4 : 0) + n;
      if (c.buf.length < need) return;
      let p = c.buf.slice(off + (masked ? 4 : 0), need);
      if (masked) { const m = c.buf.slice(off, off + 4); p = Buffer.from(p); for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3]; }
      c.buf = c.buf.slice(need);
      if (op === 8) { sendRaw(c, frame(8, Buffer.alloc(0))); return drop(c); }
      if (op === 9) { sendRaw(c, frame(10, p)); continue; }
      if (op === 10) { c.alive = true; continue; }
      if (op === 1) { c.alive = true; let m; try { m = JSON.parse(p.toString('utf8')); } catch (e) { continue; } c.msgQueue = c.msgQueue.then(() => c.open ? onMsg(c, m) : null).catch(e => console.error('hub message', e.message)); }
    }
  }
  function drop(c) {
    if (!c.open) return; c.open = false; clients.delete(c);
    try { c.sock.destroy(); } catch (e) {}
    for (const f of c.subs) unsub(c, f);
    RAID.onClose(c); DUEL.onClose(c); APVP.onClose(c);
    if (gate) gate.drop(c);
    onlineChanged();
  }
  // проверка живости: Fly закрывает тихие соединения, браузер на свёрнутой вкладке может «пропасть»
  setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { drop(c); continue; }
      c.alive = false; sendRaw(c, frame(9, Buffer.alloc(0)));
    }
  }, 25000).unref();

  // ---------- сообщения клиента ----------
  async function onMsg(c, m) {
    if (m.t === 'hello') {
      // вход: игрок присылает токен Firebase (сервер сам узнаёт логин), гость — свой случайный id
      c.uid = ''; c.gid = '';
      if (gate) gate.drop(c);   // смена пользователя: подписки шлюза оформляются заново (с новыми правами)
      c.v = Math.max(0, Math.min(PROTO, parseInt(m.v, 10) || 0)); // версия протокола клиента
      if (m.tok) { try { c.uid = await verify(String(m.tok)); } catch (e) { c.uid = ''; } }
      if (!c.uid && m.g) c.gid = String(m.g).replace(/[^a-z0-9]/gi, '').slice(0, 24);
      send(c, { t: 'me', uid: c.uid || null });
      onlineChanged(true);
      return;
    }
    if (gate && (m.t === 'fsl' || m.t === 'fsu')) return gate.onMsg(c, m, send);   // шлюз данных (STORE=pg)
    if (m.t === 'sub' && Array.isArray(m.c)) { for (const f of m.c) if (FEEDS[f]) sub(c, f); return; }
    if (m.t === 'unsub' && Array.isArray(m.c)) { for (const f of m.c) unsub(c, f); return; }
    if (m.t === 'rj' || m.t === 'rd' || m.t === 'rm' || m.t === 'rh') return RAID.onMsg(c, m, send);
    if (m.t === 'dj' || m.t === 'da') return DUEL.onMsg(c, m, send);
    // мировой цикл: босс, охота, территории, войны, клан
    if (m.t === 'wb' || m.t === 'wbcl' || m.t === 'hunt' || m.t === 'war' || m.t === 'warc' || m.t === 'clan') return CYCLE.onMsg(c, m, send);
    // арена против копии героя: бой ведёт сервер
    if (m.t === 'apvp' || m.t === 'apa') return APVP.onMsg(c, m, send);
  }

  // ---------- подписки на Firestore ----------
  // Состояние ленты: docs — полный снимок, sent — что уже разослали (id → JSON),
  // pu/pr — накопленные изменения между рассылками, o — отправленный порядок id.
  function newFeed() { return { subs: new Set(), docs: [], ready: false, un: null, idle: null, tm: null, first: true, full: false, pu: new Map(), pr: new Set(), sent: new Map(), o: [] }; }

  function sendSnap(c, F, name) { send(c, { t: 'snap', c: name, d: F.docs }); }
  function broadcastSnap(name, F) { const m = frame(1, Buffer.from(JSON.stringify({ t: 'snap', c: name, d: F.docs }))); for (const x of F.subs) sendRaw(x, m); }

  // накопление изменений: Firestore отдаёт в docChanges только изменившиеся документы
  function collect(F, sn) {
    let ch = null;
    try { ch = sn.docChanges ? sn.docChanges() : null; } catch (e) { ch = null; }
    if (!ch || !ch.length) { F.full = true; return; }
    for (const c of ch) {
      const id = c.doc && c.doc.id; if (!id) continue;
      if (c.type === 'removed') { F.pu.delete(id); F.pr.add(id); }
      else { F.pr.delete(id); let d = null; try { d = c.doc.data(); } catch (e) {} F.pu.set(id, { id, ...plain(d) }); }
    }
  }

  // полный пересчёт дельты (запасной путь, если docChanges недоступен или что-то разошлось)
  function fullDiff(F) {
    const cur = new Map(F.docs.map(d => [d.id, d]));
    const u = [], r = [];
    for (const [id, d] of cur) { const s = JSON.stringify(d); if (F.sent.get(id) !== s) u.push(d); }
    for (const id of F.sent.keys()) if (!cur.has(id)) r.push(id);
    F.sent = new Map();
    for (const [id, d] of cur) F.sent.set(id, JSON.stringify(d));
    return { u, r };
  }

  function flush(name, F) {
    if (!F.subs.size) { F.pu.clear(); F.pr.clear(); F.full = false; return; }
    let u = [], r = [];
    if (F.full) { const d = fullDiff(F); u = d.u; r = d.r; F.full = false; }
    else {
      u = [...F.pu.values()]; r = [...F.pr];
      F.pu.clear(); F.pr.clear();
      for (const d of u) F.sent.set(d.id, JSON.stringify(d));
      for (const id of r) F.sent.delete(id);
      // страховка: если размеры разошлись — дельта неполная, пересчитываем целиком
      if (F.sent.size !== F.docs.length) { const d = fullDiff(F); u = d.u; r = d.r; }
    }
    if (!u.length && !r.length) return;
    const o = F.docs.map(d => d.id);
    const ord = sameArr(F.o, o) ? null : o;
    if (ord) F.o = o;
    // v2 (новые клиенты): дельта — изменившиеся документы, удалённые id и порядок
    let b2 = null;
    for (const x of F.subs) {
      if (x.v < 2) continue;
      if (!b2) b2 = frame(1, Buffer.from(JSON.stringify({ t: 'upd', c: name, u, r, o: ord })));
      sendRaw(x, b2);
    }
    // v1 (старые клиенты): полный снимок, как раньше
    let b1 = null;
    for (const x of F.subs) {
      if (x.v >= 2) continue;
      if (!b1) b1 = frame(1, Buffer.from(JSON.stringify({ t: 'snap', c: name, d: F.docs })));
      sendRaw(x, b1);
    }
  }

  function sameArr(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

  function sub(c, name) {
    if (c.subs.has(name)) { const F = feeds[name]; if (F && F.ready) sendSnap(c, F, name); return; }
    c.subs.add(name);
    let F = feeds[name];
    if (!F) {
      const db = getDb(); if (!db) return send(c, { t: 'nofeed', c: name });
      F = feeds[name] = newFeed();
      F.un = FEEDS[name](db).onSnapshot(sn => {
        // Считаем документы, за которые Firestore обычно выставляет read:
        // initial snapshot — все документы; последующие — added/modified (removed не тарифицируется).
        if (F.first) countReads(name, sn.size == null ? sn.docs.length : sn.size, true);
        else {
          let changes;
          try { changes = sn.docChanges ? sn.docChanges() : null; } catch (e) { changes = null; }
          countReads(name, changes ? changes.filter(x => x.type !== 'removed').length : sn.docs.length, false);
        }
        F.docs = sn.docs.map(d => ({ id: d.id, ...plain(d.data()) }));
        F.ready = true;
        if (F.first) {
          // первый снимок — база для дельт; его получают все, кто уже подписан
          F.first = false;
          for (const d of F.docs) F.sent.set(d.id, JSON.stringify(d));
          broadcastSnap(name, F);
        } else collect(F, sn);
        clearTimeout(F.tm); // при частых изменениях (бой, рейд) склеиваем рассылку
        F.tm = setTimeout(() => { F.tm = null; flush(name, F); }, SNAP_MS);
      }, e => { console.error('feed', name, e.message); for (const x of F.subs) send(x, { t: 'nofeed', c: name }); });
    }
    clearTimeout(F.idle); F.idle = null;
    F.subs.add(c);
    if (F.ready) sendSnap(c, F, name);
  }
  function unsub(c, name) {
    c.subs.delete(name);
    const F = feeds[name]; if (!F) return;
    F.subs.delete(c);
    if (!F.subs.size && !F.idle) F.idle = setTimeout(() => { if (F.subs.size) return; try { F.un && F.un(); } catch (e) {} delete feeds[name]; }, IDLE_UNSUB);
  }

  // ---------- онлайн ----------
  let onlT = null;
  function onlineChanged(now) {
    clearTimeout(onlT);
    onlT = setTimeout(() => {
      const u = new Set(), g = new Set();
      for (const c of clients) { if (c.uid) u.add(c.uid); else if (c.gid) g.add(c.gid); }
      const msg = frame(1, Buffer.from(JSON.stringify({ t: 'onl', u: [...u], g: g.size })));
      for (const c of clients) sendRaw(c, msg);
    }, now ? 300 : 1500);
  }

  return { stats: () => ({ raids: RAID.stats(), duels: DUEL.stats(), cycle: CYCLE.stats(), apvp: APVP.stats(), clients: clients.size, feeds: Object.fromEntries(Object.entries(feeds).map(([k, F]) => [k, { subs: F.subs.size, docs: F.docs.length }])), firestoreReads: { since: readStats.since, total: readStats.total, byCollection: readStats.byCollection } }) };
};

// данные Firestore → обычный JSON (метки времени → миллисекунды)
function plain(v) {
  if (v == null || typeof v !== 'object') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (Array.isArray(v)) return v.map(plain);
  const o = {}; for (const k in v) o[k] = plain(v[k]); return o;
}

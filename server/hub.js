// Сокет-хаб Northfall.
// Сервер один раз слушает «горячие» коллекции Firestore и рассылает их состояние всем игрокам по WebSocket.
// Раньше каждое изменение читал каждый открытый клиент; теперь читает только сервер.
// WebSocket реализован без внешних библиотек (RFC 6455: текстовые кадры, ping/pong, close).
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

module.exports = function hub(server, getDb, verify) {
  const clients = new Set();
  const RAID = require('./raid')(getDb);
  const feeds = {}; // name → {un, docs, subs:Set, idle, ready}

  // ---------- WebSocket ----------
  server.on('upgrade', (req, sock) => {
    let u; try { u = new URL(req.url, 'http://x'); } catch (e) { return sock.destroy(); }
    const key = req.headers['sec-websocket-key'];
    if (u.pathname !== '/ws' || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      sock.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return sock.destroy();
    }
    const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
    sock.setNoDelay(true);
    const c = { sock, buf: Buffer.alloc(0), subs: new Set(), uid: '', gid: '', alive: true, open: true, t0: Date.now() };
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
      if (op === 1) { c.alive = true; let m; try { m = JSON.parse(p.toString('utf8')); } catch (e) { continue; } onMsg(c, m); }
    }
  }
  function drop(c) {
    if (!c.open) return; c.open = false; clients.delete(c);
    try { c.sock.destroy(); } catch (e) {}
    for (const f of c.subs) unsub(c, f);
    RAID.onClose(c);
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
      if (m.tok) { try { c.uid = await verify(String(m.tok)); } catch (e) { c.uid = ''; } }
      if (!c.uid && m.g) c.gid = String(m.g).replace(/[^a-z0-9]/gi, '').slice(0, 24);
      send(c, { t: 'me', uid: c.uid || null });
      onlineChanged(true);
      return;
    }
    if (m.t === 'sub' && Array.isArray(m.c)) { for (const f of m.c) if (FEEDS[f]) sub(c, f); return; }
    if (m.t === 'unsub' && Array.isArray(m.c)) { for (const f of m.c) unsub(c, f); return; }
    if (m.t === 'rj' || m.t === 'rd' || m.t === 'rm') return RAID.onMsg(c, m, send);
  }

  // ---------- подписки на Firestore ----------
  function sub(c, name) {
    if (c.subs.has(name)) { const F = feeds[name]; if (F && F.ready) send(c, { t: 'snap', c: name, d: F.docs }); return; }
    c.subs.add(name);
    let F = feeds[name];
    if (!F) {
      const db = getDb(); if (!db) return send(c, { t: 'nofeed', c: name });
      F = feeds[name] = { subs: new Set(), docs: [], ready: false, un: null, idle: null, tm: null };
      F.un = FEEDS[name](db).onSnapshot(sn => {
        F.docs = sn.docs.map(d => ({ id: d.id, ...plain(d.data()) }));
        F.ready = true;
        clearTimeout(F.tm); // при частых изменениях (бой, рейд) склеиваем рассылку
        F.tm = setTimeout(() => { const msg = frame(1, Buffer.from(JSON.stringify({ t: 'snap', c: name, d: F.docs }))); for (const x of F.subs) sendRaw(x, msg); }, 120);
      }, e => { console.error('feed', name, e.message); for (const x of F.subs) send(x, { t: 'nofeed', c: name }); });
    }
    clearTimeout(F.idle); F.idle = null;
    F.subs.add(c);
    if (F.ready) send(c, { t: 'snap', c: name, d: F.docs });
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

  return { stats: () => ({ raids: RAID.stats(), clients: clients.size, feeds: Object.fromEntries(Object.entries(feeds).map(([k, F]) => [k, { subs: F.subs.size, docs: F.docs.length }])) }) };
};

// данные Firestore → обычный JSON (метки времени → миллисекунды)
function plain(v) {
  if (v == null || typeof v !== 'object') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (Array.isArray(v)) return v.map(plain);
  const o = {}; for (const k in v) o[k] = plain(v[k]); return o;
}

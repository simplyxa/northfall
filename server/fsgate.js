// Шлюз данных для клиентов игры (вместо прямого доступа браузера к Firestore).
// Работает только при STORE=pg. Разовые операции — POST /api/fs; живые подписки — сообщения fsl/fsu по WebSocket хаба.
// Каждый запрос проверяется правилами server/fsrules.js (перенос firestore.rules); запись идёт в транзакции,
// так что проверка «что было» и запись не расходятся. Всё, что правилами не описано, запрещено.
'use strict';
const { check, ADMINS } = require('./fsrules');
const { makeLimiter } = require('./ratelimit');
const { _internals } = require('./pgdocs');

const MAXBODY = 256 * 1024, MAXDOC = 300 * 1024, MAXLIM = 500, MAXSUBS = 40, DEPTH = 24;
const LIM_USER = makeLimiter({ cap: 200, perSec: 60 });     // вошедший игрок: 60 запросов/с, всплеск 200
const LIM_ANON = makeLimiter({ cap: 40, perSec: 2 });       // без входа (проверка ника): по IP
const BADKEY = new Set(['__proto__', 'constructor', 'prototype']);

class Deny extends Error { constructor(code, msg) { super(msg); this.code = code; } }   // 7 PERMISSION_DENIED, 3 INVALID, 5 NOT_FOUND, 6 EXISTS, 8 LIMIT

// данные клиента: только обычный JSON, без «опасных» ключей и без служебных значений
function clean(v, d) {
  d = d || 0; if (d > DEPTH) throw new Deny(3, 'слишком глубоко');
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Deny(3, 'число'); return v; }
  if (Array.isArray(v)) return v.map(x => clean(x, d + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) {
      if (BADKEY.has(k) || k.startsWith('__')) throw new Deny(3, 'ключ ' + k);
      if (v[k] === undefined) continue;
      o[k] = clean(v[k], d + 1);
    }
    return o;
  }
  throw new Deny(3, 'тип');
}
function segsOf(p) {
  if (typeof p !== 'string' || !p || p.length > 600) throw new Deny(3, 'путь');
  const s = p.replace(/^\/+|\/+$/g, '').split('/');
  if (s.some(x => !x || x.length > 200 || /^__.*__$/.test(x) || x === '.' || x === '..')) throw new Deny(3, 'путь');
  return s;
}

module.exports = function fsgate(getDb, verifyUid) {
  const enabled = process.env.STORE === 'pg';
  const authOf = uid => uid ? { uid, admin: ADMINS.includes(uid) } : null;
  const dbOr = () => { const db = getDb(); if (!db) throw new Deny(14, 'нет базы'); return db; };
  const getDocFor = db => async p => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };

  // ---- запрос из описания клиента ----
  function buildQuery(db, q) {
    if (!q || typeof q !== 'object') throw new Deny(3, 'запрос');
    const segs = segsOf(q.p);
    if (segs.length % 2 !== 1) throw new Deny(3, 'не коллекция');
    let x = db.collection(segs.join('/'));
    for (const w of Array.isArray(q.w) ? q.w.slice(0, 4) : []) {
      if (!Array.isArray(w) || w.length !== 3 || typeof w[0] !== 'string') throw new Deny(3, 'where');
      if (!['==', '>', '>=', '<', '<=', 'in', 'array-contains'].includes(w[1])) throw new Deny(3, 'оператор');
      x = x.where(w[0], w[1], clean(w[2]));
    }
    for (const o of Array.isArray(q.o) ? q.o.slice(0, 2) : []) {
      if (!Array.isArray(o) || typeof o[0] !== 'string') throw new Deny(3, 'orderBy');
      x = x.orderBy(o[0], o[1] === 'desc' ? 'desc' : 'asc');
    }
    x = x.limit(Math.min(MAXLIM, Math.max(1, q.l | 0 || MAXLIM)));
    return { x, segs, sa: q.sa };
  }
  async function visible(db, auth, snaps) {
    const gd = getDocFor(db), out = [];
    for (const s of snaps) { if (await check('read', s.ref.path.split('/'), auth, s.data(), null, gd)) out.push(s); }
    return out;
  }

  // ---- разовые операции ----
  async function exec(auth, r) {
    const db = dbOr(), gd = getDocFor(db);
    const op = String(r.op || '');
    if (op === 'list') {
      const { x, segs, sa } = buildQuery(db, r.q);
      if (!auth && segs[0] !== 'names') throw new Deny(7, 'нет доступа');
      let qq = x;
      if (sa && sa.path) { const s = await db.doc(segsOf(sa.path).join('/')).get(); if (s.exists) qq = qq.startAfter(s); }
      const snap = await qq.get();
      const vis = await visible(db, auth, snap.docs);
      return { docs: vis.map(s => ({ p: s.ref.path, d: s.data() })) };
    }
    const segs = segsOf(r.path);
    if (segs.length % 2 !== 0) throw new Deny(3, 'не документ');
    const path = segs.join('/');
    if (op === 'get') {
      const s = await db.doc(path).get(), ex = s.exists ? s.data() : null;
      if (!(await check('read', segs, auth, ex, null, gd))) throw new Deny(7, 'нет доступа');
      return { ex: !!ex, d: ex };
    }
    if (!auth) throw new Deny(7, 'нужен вход');
    if (!['set', 'update', 'create', 'delete'].includes(op)) throw new Deny(3, 'операция');
    const data = op === 'delete' ? null : clean(r.data);
    if (op !== 'delete') { if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Deny(3, 'данные'); if (JSON.stringify(data).length > MAXDOC) throw new Deny(8, 'слишком большой документ'); }
    const merge = !!r.merge;
    await db.runTransaction(async tx => {
      const ref = db.doc(path), cur = await tx.get(ref), ex = cur.exists ? cur.data() : null;
      let incoming = null, kind;
      if (op === 'delete') kind = 'delete';
      else if (op === 'create') { if (ex) throw new Deny(6, 'уже есть'); kind = 'create'; incoming = _internals.applyOp(null, { k: 'create', path, data }); }
      else if (op === 'update') { if (!ex) throw new Deny(5, 'нет документа'); kind = 'update'; incoming = _internals.applyOp(ex, { k: 'update', path, data }); }
      else { kind = ex ? 'update' : 'create'; incoming = _internals.applyOp(ex, { k: 'set', path, data, merge }); }
      if (incoming && JSON.stringify(incoming).length > MAXDOC) throw new Deny(8, 'слишком большой документ');
      if (!(await check(kind, segs, auth, ex, incoming, async p => { const s = await tx.get(db.doc(p)); return s.exists ? s.data() : null; }))) throw new Deny(7, 'нет доступа');
      if (op === 'delete') { if (ex) tx.delete(ref); }
      else if (op === 'create') tx.create(ref, data);
      else if (op === 'update') tx.update(ref, data);
      else tx.set(ref, data, { merge });
    });
    return {};
  }

  async function http(req, res, body) {
    const J = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
    if (!enabled) return J(404, { ok: false, code: 12, msg: 'off' });
    try {
      if (body.length > MAXBODY) return J(413, { ok: false, code: 3, msg: 'big' });
      let r; try { r = JSON.parse(body.toString('utf8')); } catch (e) { return J(400, { ok: false, code: 3, msg: 'json' }); }
      const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      let uid = '';
      if (tok) { try { uid = await verifyUid(tok); } catch (e) { return J(401, { ok: false, code: 16, msg: 'auth' }); } }
      const lim = uid ? LIM_USER : LIM_ANON, key = uid || (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '?');
      if (!lim(String(key))) return J(429, { ok: false, code: 8, msg: 'rate' });
      return J(200, { ok: true, r: await exec(authOf(uid), r) });
    } catch (e) {
      if (e instanceof Deny) return J(e.code === 7 ? 403 : 400, { ok: false, code: e.code, msg: e.message });
      console.error('fs', e && e.code, e && e.message); return J(500, { ok: false, code: 13, msg: 'db' });
    }
  }

  // ---- живые подписки (по WebSocket хаба) ----
  const feeds = new Map();       // ключ запроса → { un, snaps, subs:Set, ready, busy, again }
  async function pushFeed(F) {
    if (F.busy) { F.again = true; return; }
    F.busy = true;
    try {
      do {
        F.again = false;
        for (const s of [...F.subs]) {
          if (!s.c.open) continue;
          const db = getDb(); if (!db) continue;
          const vis = await visible(db, s.auth, F.snaps), up = [], now = new Map();
          for (const d of vis) { const p = d.ref.path, j = JSON.stringify(d.data()); now.set(p, j); if (s.sent.get(p) !== j) up.push({ p, d: d.data() }); }
          const rm = [...s.sent.keys()].filter(p => !now.has(p)), o = vis.map(d => d.ref.path);
          const orderChanged = s.order.length !== o.length || o.some((p, i) => p !== s.order[i]);
          if (!s.first && !up.length && !rm.length && !orderChanged) continue;
          s.send(s.c, { t: 'fss', id: s.id, full: s.first, up, rm, o: orderChanged || s.first ? o : undefined });
          s.first = false; s.sent = now; s.order = o;
        }
      } while (F.again);
    } catch (e) { console.error('fs feed', e.message); }
    F.busy = false;
  }
  function startFeed(key, q) {
    const db = dbOr();
    const F = { subs: new Set(), snaps: [], un: null, idle: null, busy: false, again: false };
    const on = snaps => { F.snaps = snaps; F.got = true; pushFeed(F); };
    const err = e => { for (const s of F.subs) s.send(s.c, { t: 'fse', id: s.id, code: 13 }); console.error('fs feed', e.message); stopFeed(key); };
    if (q.d) { const ref = db.doc(segsOf(q.d).join('/')); F.un = ref.onSnapshot(sn => on(sn.exists ? [sn] : []), err); }
    else { const { x } = buildQuery(db, q); F.un = x.onSnapshot(sn => on(sn.docs), err); }
    feeds.set(key, F); return F;
  }
  function stopFeed(key) { const F = feeds.get(key); if (!F) return; feeds.delete(key); try { F.un && F.un(); } catch (e) {} }

  function sub(c, m, send) {
    if (!enabled) return send(c, { t: 'fse', id: m.id, code: 12 });
    try {
      const id = String(m.id || ''); if (!id || id.length > 40) throw new Deny(3, 'id');
      c.fs = c.fs || new Map();
      if (c.fs.size >= MAXSUBS && !c.fs.has(id)) throw new Deny(8, 'слишком много подписок');
      if (c.fs.has(id)) unsub(c, { id });
      const q = m.q; if (!q || typeof q !== 'object') throw new Deny(3, 'запрос');
      const segs = q.d ? segsOf(q.d) : segsOf(q.p), auth = authOf(c.uid);
      if (!auth && segs[0] !== 'names') throw new Deny(7, 'нужен вход');
      if (q.d ? segs.length % 2 !== 0 : segs.length % 2 !== 1) throw new Deny(3, 'путь');
      const key = JSON.stringify(q.d ? { d: segs.join('/') } : { p: segs.join('/'), w: q.w || [], o: q.o || [], l: q.l | 0 });
      let F = feeds.get(key);
      if (!F) F = startFeed(key, q.d ? { d: segs.join('/') } : { p: segs.join('/'), w: q.w, o: q.o, l: q.l });
      clearTimeout(F.idle); F.idle = null;
      const s = { c, id, auth, key, sent: new Map(), order: [], first: true, send };
      c.fs.set(id, s); F.subs.add(s);
      if (F.got) pushFeed(F);   // подписка на уже идущую ленту получает снимок сразу; новая — по первому ответу базы
    } catch (e) { send(c, { t: 'fse', id: m && m.id, code: e instanceof Deny ? e.code : 13 }); }
  }
  function unsub(c, m) {
    const s = c.fs && c.fs.get(String(m.id)); if (!s) return;
    c.fs.delete(s.id);
    const F = feeds.get(s.key); if (!F) return;
    F.subs.delete(s);
    if (!F.subs.size) F.idle = setTimeout(() => { if (!F.subs.size) stopFeed(s.key); }, 30000);
  }
  function drop(c) { if (c.fs) for (const id of [...c.fs.keys()]) unsub(c, { id }); }
  function onMsg(c, m, send) { if (m.t === 'fsl') return sub(c, m, send); if (m.t === 'fsu') return unsub(c, m); }
  function stats() { return { enabled, feeds: feeds.size, subs: [...feeds.values()].reduce((n, F) => n + F.subs.size, 0) }; }

  return { enabled, http, exec, onMsg, drop, stats, _authOf: authOf };
};

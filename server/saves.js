// Сохранения и экономические действия через наш сервер.
//  • /api/save — сохранение героя: проверка «линии» (старая вкладка не затрёт свежий прогресс),
//    «копилка» серебра (лишнее сверх возможного заработка не засчитывается), флаги подозрительных скачков.
//  • /api/op — сохранение + действие одной транзакцией: выставить/снять лот на рынке, отправить вещь
//    по почте, забрать вещь из письма, внести вклад в казну клана. Вещь и ресурсы берутся из сохранения
//    на сервере, поэтому их нельзя «раздвоить» старой вкладкой или вписать себе из воздуха.
//  • /api/flags — список подозрительных изменений (для админов).
'use strict';
const DOM = '@northfall.game';
const checkHero = require('./items');
const { makeLimiter } = require('./ratelimit');
// Клиент шлёт сохранение раз в 5 секунд (автосейв при изменении энергии/здоровья),
// в бою — чаще. Запас большой: обычный игрок укладывается в 12-20 сохранений в минуту.
// Каждое сохранение — транзакция Firestore, поэтому и режем, и защищаем кошелёк.
const LIM_SAVE = makeLimiter({ cap: 30, perSec: 50 / 60 });   // всплеск 30, восстановление 50/мин
const LIM_OP = makeLimiter({ cap: 15, perSec: 30 / 60 });     // рынок/письма/казна: редкие, но дорогие
// вещи: пока только отмечаем подозрительные (ITEM_CLAMP=on — урезать завышенные характеристики)
const ITEM_CLAMP = process.env.ITEM_CLAMP === 'on';
const MAXB = 900 * 1024;
const ADMINS = ['shtorm1', 'admin'];
const INV_MAX = 20, GAU = 1, MAX_PRICE = 1e6;
// честный потолок дохода серебром в секунду: ~15 убийств в минуту сильных зверей своего уровня (с запасом)
const silverRate = lv => 15 * (5 + lv * 9) / 60;
const rid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const pid = (a, b) => [a, b].sort().join('~');
class Fail extends Error { constructor(code, msg) { super(msg); this.code = code; } }

module.exports = function saves(admin) {
  const last = new Map(), recent = new Map();

  // карты не растут бесконечно: чистим старые записи
  function prune() {
    const now = Date.now();
    for (const [k, t] of last) if (now - t > 3600000) last.delete(k);
    for (const [k, t] of recent) if (now - t > 600000) recent.delete(k);
  }
  setInterval(prune, 10 * 60000).unref();

  async function flag(db, uid, kind, info) {
    const now = Date.now();
    if (now - (recent.get(uid + kind) || 0) < 10 * 60000) return;
    recent.set(uid + kind, now);
    console.warn('save flag', uid, kind, JSON.stringify(info));
    try { await db.collection('flags').doc(uid + '_' + now.toString(36)).set({ uid, kind, ...info, ts: now }); } catch (e) {}
  }
  const J = (res, code, o, hdr) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(hdr || {}) }); res.end(JSON.stringify(o)); };
  async function who(req) {
    const a = admin(); if (!a) throw new Fail(503, 'not_configured');
    try {
      const d = await a.auth().verifyIdToken(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      if (!d.email || !d.email.endsWith(DOM)) throw 0;
      return { a, uid: d.email.slice(0, -DOM.length) };
    } catch (e) { throw new Fail(401, 'auth'); }
  }

  // общая часть: проверка линии сохранений и копилки серебра (внутри транзакции, до записи)
  function guard(prev, s, ses, base, uid) {
    if (prev && prev.ses && prev.ses !== ses && prev.ses !== base) return { stale: true };
    s.ses = ses; s.acc = uid; delete s._eb;
    const now = Date.now(), lv = Math.max(1, s.lvl | 0), rate = silverRate(lv), cap = rate * 7200 + 50000;
    const eb = prev && prev._eb ? prev._eb : { b: cap, t: now };
    let bud = Math.min(cap, (+eb.b || 0) + Math.max(0, now - (+eb.t || now)) / 1000 * rate);
    const gift = prev && JSON.stringify(prev.applied || []) !== JSON.stringify(s.applied || []);
    let fix = null, clamp = null;
    if (prev && !gift) {
      const gain = (+s.gold || 0) - (+prev.gold || 0);
      if (gain > bud) { clamp = { from: prev.gold | 0, to: s.gold | 0, allowed: Math.floor(bud) }; s.gold = (+prev.gold || 0) + Math.floor(bud); fix = { gold: s.gold }; bud = 0; }
      else if (gain > 0) bud -= gain;
    }
    s._eb = { b: Math.round(bud), t: now };
    // вещи: проверяем копию; при ITEM_CLAMP — правим в самом сохранении и сообщаем игре
    let items = null;
    try {
      const target = ITEM_CLAMP ? s : JSON.parse(JSON.stringify({ inv: s.inv, eq: s.eq }));
      const bad = checkHero(target);
      if (bad.length) { items = bad.map(b => ({ uid: b.uid, where: b.where, why: b.why, name: b.item.name })); if (ITEM_CLAMP) { fix = fix || {}; fix.items = bad.map(b => ({ uid: b.uid, where: b.where, item: b.item })); } }
    } catch (e) {}
    return { fix, clamp, items };
  }
  function after(db, uid, prev, s, g) {
    if (g.clamp) flag(db, uid, 'clamp', { ...g.clamp, dtMin: 0 });
    if (g.items) flag(db, uid, 'item', { list: g.items.slice(0, 5), clamped: ITEM_CLAMP, dtMin: 0 });
    try {
      const p = prev || {}, now = Date.now(), dt = Math.max(1, now - (last.get(uid) || p.ts || now - 60000));
      const gift = JSON.stringify(p.applied || []) !== JSON.stringify(s.applied || []);
      const dl = (s.lvl | 0) - (p.lvl | 0);
      if (!gift && prev && dl >= 5 && dt < 15 * 60000) flag(db, uid, 'lvl', { from: p.lvl, to: s.lvl, dtMin: Math.round(dt / 60000) });
      last.set(uid, now);
    } catch (e) {}
  }
  function readSave(body, uid) {
    if (body.length > MAXB) throw new Fail(413, 'too big');
    let q; try { q = JSON.parse(body.toString('utf8')); } catch (e) { throw new Fail(400, 'json'); }
    const s = q && q.s, ses = String(q.ses || ''), base = q.base ? String(q.base) : null;
    if (!s || typeof s !== 'object' || !Array.isArray(s.inv) || !ses || (s.acc && s.acc !== uid)) throw new Fail(400, 'bad save');
    return { q, s, ses, base };
  }

  // ---------- /api/save ----------
  async function handle(req, res, body) {
    try {
      const { a, uid } = await who(req);
      if (!LIM_SAVE(uid)) return J(res, 429, { error: 'Слишком частые сохранения' }, { 'Retry-After': String(LIM_SAVE.retryAfter(uid)) });
      const { s, ses, base } = readSave(body, uid);
      const db = a.firestore(), ref = db.collection('saves').doc(uid);
      let prev = null, g = null;
      await db.runTransaction(async tx => {
        const sn = await tx.get(ref); prev = sn.exists ? sn.data() : null;
        g = guard(prev, s, ses, base, uid); if (g.stale) return;
        tx.set(ref, s);
      });
      if (g.stale) return J(res, 409, { stale: 1 });
      after(db, uid, prev, s, g);
      return J(res, 200, g.fix ? { ok: 1, fix: g.fix } : { ok: 1 });
    } catch (e) { if (e instanceof Fail) return J(res, e.code, { error: e.message }); console.error('save', e); return J(res, 500, { error: 'db' }); }
  }

  // ---------- /api/op ----------
  async function op(req, res, body) {
    try {
      const { a, uid } = await who(req);
      if (!LIM_OP(uid)) return J(res, 429, { error: 'Слишком частые операции' }, { 'Retry-After': String(LIM_OP.retryAfter(uid)) });
      const { q, s, ses, base } = readSave(body, uid);
      const o = q.op || {}, k = String(o.k || '');
      const db = a.firestore(), ref = db.collection('saves').doc(uid);
      let prev = null, g = null, out = null;
      await db.runTransaction(async tx => {
        out = null;
        // все чтения — до записей (правило транзакций Firestore)
        const sn = await tx.get(ref); prev = sn.exists ? sn.data() : null;
        let mref, ms, wref, ws, dref, ds, tref, ts;
        if (k === 'mkcancel') { mref = db.collection('market').doc(String(o.id || '')); ms = await tx.get(mref); }
        if (k === 'give') {
          if (!/^[a-z0-9_]{2,20}$/.test(String(o.to || '')) || o.to === uid) throw new Fail(400, 'Игрок не найден');
          tref = db.collection('saves').doc(o.to); ts = await tx.get(tref); if (!ts.exists) throw new Fail(404, 'Игрок не найден');
          wref = db.collection('wallet').doc(uid); ws = await tx.get(wref);
        }
        if (k === 'take') { dref = db.collection('dm').doc(String(o.pair || '')).collection('m').doc(String(o.mid || '')); ds = await tx.get(dref); }
        if (k === 'donate') { if (!s.clan) throw new Fail(400, 'Нет клана'); dref = db.collection('clans').doc(String(s.clan)).collection('dep').doc(uid); ds = await tx.get(dref); }

        g = guard(prev, s, ses, base, uid); if (g.stale) return;
        const takeItem = iu => { const i = s.inv.findIndex(x => x && x.uid === iu); if (i < 0) throw new Fail(409, 'Вещи нет в рюкзаке'); const it = s.inv[i]; if (it.pb) throw new Fail(400, 'Эту вещь нельзя передать'); s.inv.splice(i, 1); const c = JSON.parse(JSON.stringify(it)); delete c.uid; delete c.mkp; return c; };
        const putItem = it => { if (s.inv.length >= INV_MAX) throw new Fail(409, 'Рюкзак полон'); const c = JSON.parse(JSON.stringify(it)); c.uid = rid('i'); c.pb = 0; s.inv.push(c); return c; };

        if (k === 'mklist') { // выставить вещь на рынок за золото
          const price = Math.floor(+o.price || 0); if (!(price >= 1 && price <= MAX_PRICE)) throw new Fail(400, 'Неверная цена');
          const item = takeItem(String(o.iu || '')), id = rid('m');
          tx.set(db.collection('market').doc(id), { seller: uid, sname: String(s.name || uid).slice(0, 20), item, price, au: true, ts: Date.now(), sold: false, srv: 1 });
          out = { id, iu: o.iu };
        } else if (k === 'mkcancel') { // снять лот — вещь возвращается в рюкзак
          if (!ms.exists) throw new Fail(404, 'Лот не найден'); const m = ms.data();
          if (m.seller !== uid) throw new Fail(403, 'Это не твой лот'); if (m.sold) throw new Fail(409, 'Вещь уже купили, забери выручку');
          const it = putItem(m.item); tx.delete(mref); out = { item: it };
        } else if (k === 'give') { // отправить вещь по почте (1 золото)
          if (!ws.exists || (ws.data().au | 0) < GAU) throw new Fail(409, `Передача вещи стоит ${GAU} золото`);
          const item = takeItem(String(o.iu || '')), now = Date.now(), note = String(o.note || '').slice(0, 200);
          const text = `📦 Передаёт вещь «${String(item.name || '').slice(0, 60)}»${note ? ': ' + note : ''}`;
          tx.update(wref, { au: (ws.data().au | 0) - GAU });
          tx.set(wref.collection('log').doc(now.toString(36) + 'g'), { op: 'pay', n: -GAU, why: 'give', ts: now });
          const mid = 'm' + now.toString(36) + Math.random().toString(36).slice(2, 5);
          tx.set(db.collection('dm').doc(pid(uid, o.to)).collection('m').doc(mid), { from: uid, name: String(s.name || uid).slice(0, 20), text, ts: now, item, claimed: false, paid: 0, srv: 1 });
          out = { iu: o.iu, mid, text, ts: now, au: (ws.data().au | 0) - GAU };
        } else if (k === 'take') { // забрать вещь из письма
          if (!String(o.pair || '').split('~').includes(uid)) throw new Fail(403, 'Нет доступа');
          if (!ds.exists) throw new Fail(404, 'Письмо не найдено'); const m = ds.data();
          if (!m.item || m.claimed || m.from === uid) throw new Fail(409, 'Вещь уже забрали');
          const it = putItem(m.item); tx.update(dref, { claimed: true, claimedTs: Date.now() }); out = { item: it };
        } else if (k === 'donate') { // вклад в казну клана
          const n = Math.floor(+o.n || 0), kind = o.kind === 'i' ? 'i' : 'g'; if (!(n > 0 && n <= 1e7)) throw new Fail(400, 'Неверная сумма');
          if (kind === 'g') { if ((+s.gold || 0) < n) throw new Fail(409, 'Не хватает серебра'); s.gold -= n; } else { if ((s.iron | 0) < n) throw new Fail(409, 'Не хватает железа'); s.iron -= n; }
          const d = ds.exists ? ds.data() : { gold: 0, iron: 0 };
          const nd = { name: String(s.name || uid).slice(0, 20), gold: (d.gold | 0) + (kind === 'g' ? n : 0), iron: (d.iron | 0) + (kind === 'i' ? n : 0) };
          tx.set(dref, nd);
          s.dep = s.dep || {}; s.dep[s.clan] = { g: nd.gold, i: nd.iron };
          out = { kind, n, dep: s.dep[s.clan] };
        } else throw new Fail(400, 'Неизвестное действие');
        tx.set(ref, s);
      });
      if (g && g.stale) return J(res, 409, { stale: 1 });
      after(db, uid, prev, s, g);
      return J(res, 200, { ok: 1, res: out, fix: g && g.fix || undefined });
    } catch (e) { if (e instanceof Fail) return J(res, e.code, { error: e.message }); console.error('op', e); return J(res, 500, { error: 'db' }); }
  }

  // ---------- /api/flags ----------
  async function flags(req, res) {
    try {
      const { a, uid } = await who(req);
      if (!ADMINS.includes(uid)) return J(res, 403, { error: 'Нет доступа' });
      const sn = await a.firestore().collection('flags').orderBy('ts', 'desc').limit(50).get();
      return J(res, 200, { L: sn.docs.map(x => x.data()) });
    } catch (e) { if (e instanceof Fail) return J(res, e.code, { error: e.message }); return J(res, 500, { error: 'db' }); }
  }

  handle.op = op; handle.flags = flags;
  return handle;
};

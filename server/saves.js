// Сохранения героев через наш сервер (шаг 2 переезда, первая часть).
// Игра больше не пишет сохранение в базу сама: она отправляет его серверу, а сервер
//  1) проверяет «линию» сохранений (старая вкладка другого устройства не затрёт свежий прогресс),
//  2) замечает подозрительные скачки (уровень, серебро) и записывает их для админа,
//  3) записывает сохранение в Firestore.
// Позже, когда все игроки обновятся, правила базы запретят игрокам писать в saves напрямую.
'use strict';
const DOM = '@northfall.game';
const MAXB = 900 * 1024; // документ Firestore — до 1 МБ

module.exports = function saves(admin) {
  const last = new Map(); // uid → {lvl, gold, at, applied}
  const recent = new Map(); // uid → время последнего флага (не спамить)

  async function flag(db, uid, kind, info) {
    const now = Date.now();
    if (now - (recent.get(uid + kind) || 0) < 10 * 60000) return;
    recent.set(uid + kind, now);
    console.warn('save flag', uid, kind, JSON.stringify(info));
    try { await db.collection('flags').doc(uid + '_' + now.toString(36)).set({ uid, kind, ...info, ts: now }); } catch (e) {}
  }

  // список подозрительных изменений — только для админов
  async function flags(req, res) {
    const J = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
    const a = admin(); if (!a) return J(503, { error: 'not_configured' });
    try {
      const d = await a.auth().verifyIdToken(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      const uid = (d.email || '').slice(0, -DOM.length);
      if (!['shtorm1', 'admin'].includes(uid)) return J(403, { error: 'Нет доступа' });
    } catch (e) { return J(401, { error: 'auth' }); }
    const sn = await a.firestore().collection('flags').orderBy('ts', 'desc').limit(50).get();
    return J(200, { L: sn.docs.map(x => x.data()) });
  }
  handle.flags = flags;
  return handle;
  async function handle(req, res, body) {
    const J = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
    const a = admin(); if (!a) return J(503, { error: 'not_configured' });
    let uid;
    try {
      const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const d = await a.auth().verifyIdToken(tok);
      if (!d.email || !d.email.endsWith(DOM)) return J(403, { error: 'Нет доступа' });
      uid = d.email.slice(0, -DOM.length);
    } catch (e) { return J(401, { error: 'auth' }); }
    if (body.length > MAXB) return J(413, { error: 'too big' });
    let q; try { q = JSON.parse(body.toString('utf8')); } catch (e) { return J(400, { error: 'json' }); }
    const s = q && q.s, ses = String(q.ses || ''), base = q.base ? String(q.base) : null;
    if (!s || typeof s !== 'object' || !ses || s.acc && s.acc !== uid) return J(400, { error: 'bad save' });
    s.ses = ses; s.acc = uid;
    const db = a.firestore(), ref = db.collection('saves').doc(uid);
    let prev = null, stale = false;
    try {
      await db.runTransaction(async tx => {
        const sn = await tx.get(ref); prev = sn.exists ? sn.data() : null;
        if (prev && prev.ses && prev.ses !== ses && prev.ses !== base) { stale = true; return; }
        tx.set(ref, s);
      });
    } catch (e) { console.error('save tx', uid, e.message); return J(500, { error: 'db' }); }
    if (stale) return J(409, { stale: 1 });
    // подозрительные скачки — только записываем для админа, игру не блокируем
    try {
      const p = prev || {}, now = Date.now(), dt = Math.max(1, now - (last.get(uid) || p.ts || now - 60000));
      const gift = JSON.stringify(p.applied || []) !== JSON.stringify(s.applied || []);
      const dl = (s.lvl | 0) - (p.lvl | 0), dg = (+s.gold || 0) - (+p.gold || 0);
      if (!gift && prev) {
        if (dl >= 5 && dt < 15 * 60000) flag(db, uid, 'lvl', { from: p.lvl, to: s.lvl, dtMin: Math.round(dt / 60000) });
        if (dg > Math.max(30000, (s.lvl | 0) * 4000) && dt < 10 * 60000) flag(db, uid, 'silver', { from: p.gold | 0, to: s.gold | 0, dtMin: Math.round(dt / 60000) });
      }
      last.set(uid, now);
    } catch (e) {}
    return J(200, { ok: 1 });
  }
};

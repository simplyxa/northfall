// Воронка игроков по источникам рекламы: визит → игра без регистрации → регистрация → 5 уровень.
// Счётчики по дням в Firestore stats/{ГГГГ-ММ-ДД} (читает только сервер). Просмотр — только для администрации.
const admin = require('../lib/fb');
const DOM = '@northfall.game';
const ADMINS = ['shtorm1', 'admin'];
const EV = ['visit', 'scr', 'tap', 'guest', 'reg', 'lvl5'];
const j = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const day = (t) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return j(405, { error: 'POST only' });
    if (admin.initErr && admin.initErr()) return j(200, { ok: false });
    let q = {}; try { q = JSON.parse(event.body || '{}'); } catch (e) {}
    const db = admin.firestore();
    if (q.a === 'get') {
      let uid = '';
      try { const tok = (event.headers.authorization || '').replace(/^Bearer\s+/i, ''); const d = await admin.auth().verifyIdToken(tok); uid = (d.email || '').endsWith(DOM) ? d.email.slice(0, -DOM.length) : ''; } catch (e) {}
      if (!ADMINS.includes(uid)) return j(403, { error: 'Только для администрации' });
      const n = Math.max(1, Math.min(60, q.days | 0 || 14)), out = {};
      for (let i = 0; i < n; i++) { const k = day(Date.now() - i * 864e5); const sn = await db.collection('stats').doc(k).get(); if (sn.exists) out[k] = sn.data(); }
      const er = await db.collection('priv').doc('client-errors').get();
      return j(200, { days: out, errors: ((er.exists && er.data().L) || []).slice(-30).reverse() });
    }
    // ошибки в браузерах игроков: последние 40 (без личных данных)
    if (q.a === 'err') {
      if (/^Script error|messageHandlers|Java object is gone|IDBDatabase|Database deleted|IndexedDB/i.test(String(q.m || ''))) return j(200, { ok: true, skip: 1 });
      const ref = db.collection('priv').doc('client-errors');
      const it = { t: Date.now(), m: String(q.m || '').slice(0, 220), u: String(q.u || '').slice(0, 160), v: String(q.v || '').slice(0, 12), s: String(q.s || '').slice(0, 24), w: String(q.w || '').slice(0, 20) };
      await db.runTransaction(async tx => { const sn = await tx.get(ref); const L = ((sn.exists && sn.data().L) || []).slice(-39); L.push(it); tx.set(ref, { L }); });
      return j(200, { ok: true });
    }
    // гости онлайн: гость раз в минуту отмечается, все игроки получают количество
    if (q.a === 'ping' || q.a === 'online') {
      const ref = db.collection('priv').doc('guests-online'), now = Date.now(), TTL = 3 * 60000;
      if (q.a === 'online') { const sn = await ref.get(); const m = (sn.exists && sn.data().m) || {}; return j(200, { g: Object.values(m).filter(t => now - t < TTL).length }); }
      const g = String(q.g || '').replace(/[^a-z0-9]/gi, '').slice(0, 16);
      if (g.length < 8) return j(400, { error: 'bad id' });
      let cnt = 0;
      await db.runTransaction(async tx => { const sn = await tx.get(ref); const m0 = (sn.exists && sn.data().m) || {}, m = {};
        for (const [k, t] of Object.entries(m0)) if (now - t < TTL) m[k] = t; m[g] = now; cnt = Object.keys(m).length;
        if (cnt > 2000) return; tx.set(ref, { m }); });
      return j(200, { g: cnt });
    }
    const e = String(q.e || ''), s = (String(q.s || 'direct').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24)) || 'direct';
    if (!EV.includes(e)) return j(400, { error: 'bad event' });
    const hh = new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Jerusalem' }).slice(0, 2);
    const inc = admin.firestore.FieldValue.increment(1);
    await db.collection('stats').doc(day(Date.now())).set({ [s + '__' + e]: inc, ['h' + hh + '__' + s + '__' + e]: inc }, { merge: true });
    return j(200, { ok: true });
  } catch (err) { console.error('track', err); return j(200, { ok: false }); }
};

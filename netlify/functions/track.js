// Воронка игроков по источникам рекламы: визит → игра без регистрации → регистрация → 5 уровень.
// Счётчики по дням в Firestore stats/{ГГГГ-ММ-ДД} (читает только сервер). Просмотр — только для администрации.
const admin = require('../lib/fb');
const DOM = '@northfall.game';
const ADMINS = ['shtorm1', 'admin'];
const EV = ['visit', 'guest', 'reg', 'lvl5'];
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
      return j(200, { days: out });
    }
    const e = String(q.e || ''), s = (String(q.s || 'direct').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24)) || 'direct';
    if (!EV.includes(e)) return j(400, { error: 'bad event' });
    await db.collection('stats').doc(day(Date.now())).set({ [s + '__' + e]: admin.firestore.FieldValue.increment(1) }, { merge: true });
    return j(200, { ok: true });
  } catch (err) { console.error('track', err); return j(200, { ok: false }); }
};

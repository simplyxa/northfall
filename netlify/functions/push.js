// Подписка на уведомления и уведомления о событиях (сообщение, сбор рейда).
const admin = require('../lib/fb');
const { vapid, sendTo } = require('../lib/push');
const DOM = '@northfall.game';
const j = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const KINDS = ['en', 'msg', 'raid', 'wb'];

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return j(405, { error: 'POST only' });
    if (admin.initErr && admin.initErr()) return j(500, { error: 'Сервер: ' + admin.initErr() });
    let q = {}; try { q = JSON.parse(event.body || '{}'); } catch (e) {}
    const db = admin.firestore();
    if (q.a === 'key') { const k = await vapid(db); return j(200, { key: k.publicKey }); }

    let uid;
    try {
      const tok = (event.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const dec = await admin.auth().verifyIdToken(tok);
      if (!dec.email || !dec.email.endsWith(DOM)) return j(403, { error: 'Нет доступа' });
      uid = dec.email.slice(0, -DOM.length);
    } catch (e) { return j(401, { error: 'Войди в игру заново' }); }
    const ref = db.collection('push').doc(uid);

    if (q.a === 'sub') { // сохранить подписку и настройки
      const sub = q.sub && q.sub.endpoint && q.sub.keys ? { endpoint: String(q.sub.endpoint).slice(0, 600), keys: { p256dh: String(q.sub.keys.p256dh || '').slice(0, 200), auth: String(q.sub.keys.auth || '').slice(0, 100) } } : null;
      const off = (Array.isArray(q.off) ? q.off : []).filter(k => KINDS.includes(k));
      await ref.set({ sub, off, ts: Date.now() }, { merge: true });
      return j(200, { ok: true });
    }
    if (q.a === 'state') { // когда энергия будет полной, уровень, день последней атаки на мирового босса
      const enAt = Math.max(0, Math.min(Date.now() + 864e5, Math.floor(+q.enAt || 0)));
      await ref.set({ enAt, lvl: Math.max(1, Math.min(60, q.lvl | 0)), wbDay: q.wbDay | 0, name: String(q.name || uid).slice(0, 20), st: Date.now() }, { merge: true });
      return j(200, { ok: true });
    }
    if (q.a === 'msg') { // новое сообщение: не чаще раза в 10 минут от одного игрока
      const to = String(q.to || '');
      if (!/^[a-z0-9_]{3,16}$/.test(to) || to === uid) return j(400, { error: 'Неверные данные' });
      const g = db.collection('push').doc(to), sn = await g.get();
      if (!sn.exists) return j(200, { ok: false });
      const last = (sn.data().msgFrom || {})[uid] || 0;
      if (Date.now() - last < 10 * 60000) return j(200, { ok: false });
      await g.set({ msgFrom: { [uid]: Date.now() } }, { merge: true });
      const sent = await sendTo(db, to, 'msg', { t: 'Northfall: новое сообщение', b: `${String(q.name || uid).slice(0, 20)} написал тебе`, tag: 'msg-' + uid, u: '/?go=friends' });
      return j(200, { ok: sent });
    }
    if (q.a === 'duelc') { // вызов на дуэль: не чаще раза в 2 минуты одному игроку
      const to = String(q.to || '');
      if (!/^[a-z0-9_]{3,16}$/.test(to) || to === uid) return j(400, { error: 'Неверные данные' });
      const g = db.collection('push').doc(to), sn = await g.get();
      if (!sn.exists) return j(200, { ok: false });
      const last = (sn.data().duelFrom || {})[uid] || 0;
      if (Date.now() - last < 2 * 60000) return j(200, { ok: false });
      await g.set({ duelFrom: { [uid]: Date.now() } }, { merge: true });
      const ok = await sendTo(db, to, 'msg', { t: 'Northfall: вызов на лайв-арену!', b: `${String(q.name || uid).slice(0, 20)} вызывает тебя на дуэль. 2 минуты на ответ!`, tag: 'duel', u: '/?go=duel' });
      return j(200, { ok });
    }
    if (q.a === 'cinv') { // приглашение в клан: только лидер/офицер, приглашение должно быть в документе клана
      const to = String(q.to || ''), cid = String(q.cid || '');
      if (!/^[a-z0-9_]{3,16}$/.test(to) || to === uid || !cid || cid.includes('/')) return j(400, { error: 'Неверные данные' });
      const cs = await db.collection('clans').doc(cid).get();
      if (!cs.exists) return j(200, { ok: false });
      const c = cs.data();
      if (!(c.leader === uid || (c.off || []).includes(uid)) || !(c.inv || []).some(x => x && x.id === to)) return j(200, { ok: false });
      const g = db.collection('push').doc(to), sn = await g.get();
      if (!sn.exists) return j(200, { ok: false });
      const last = (sn.data().invFrom || {})[cid] || 0;
      if (Date.now() - last < 30 * 60000) return j(200, { ok: false });
      await g.set({ invFrom: { [cid]: Date.now() } }, { merge: true });
      const ok = await sendTo(db, to, 'msg', { t: 'Northfall: приглашение в клан', b: `${String(q.name || uid).slice(0, 20)} зовёт тебя в клан «${String(c.name || '').slice(0, 20)}»`, tag: 'cinv', u: '/?go=clan' });
      return j(200, { ok });
    }
    if (q.a === 'gchat') { // сообщение в общем чате: зовём администрацию, не чаще раза в 3 минуты
      const ADMINS = ['shtorm1', 'admin'];
      if (ADMINS.includes(uid)) return j(200, { ok: false });
      const st = db.collection('priv').doc('gchat-push'), ss = await st.get();
      if (ss.exists && Date.now() - (ss.data().ts || 0) < 3 * 60000) return j(200, { ok: false });
      await st.set({ ts: Date.now(), by: uid });
      const name = String(q.name || uid).slice(0, 20), txt = String(q.text || '').replace(/\s+/g, ' ').slice(0, 90);
      const r = await Promise.all(ADMINS.map(id => sendTo(db, id, 'msg', { t: 'Northfall: пишут в общем чате', b: `${name}: ${txt}`, tag: 'gchat', u: '/?go=gchat' })));
      return j(200, { ok: r.some(Boolean) });
    }
    if (q.a === 'raid') { // рейд собрался: зовём живых участников
      const rs = await db.collection('raids').doc(String(q.rid || '')).get();
      if (!rs.exists) return j(404, { error: 'Рейд не найден' });
      const R = rs.data();
      if (!R.mem || !R.mem[uid] || Date.now() - (R.ts || 0) > 120000) return j(200, { ok: false });
      const ids = Object.keys(R.mem).filter(id => !R.mem[id].bot && id !== uid);
      await Promise.all(ids.map(id => sendTo(db, id, 'raid', { t: 'Northfall: рейд собран!', b: 'Группа готова — бой начинается. Ход 10 секунд!', tag: 'raid', u: '/?go=raid' })));
      return j(200, { ok: true });
    }
    return j(400, { error: 'Неизвестное действие' });
  } catch (e) { console.error('push fn', e); return j(500, { error: 'Ошибка сервера' }); }
};

// Кошелёк золота: золото хранится и меняется только здесь (на сервере).
// Игрок может только читать свой кошелёк wallet/{логин}.
const admin = require('../lib/fb');
const DOM = '@northfall.game';
const ADMINS = ['shtorm1', 'admin'];
const XLIM = 5, REFG = 10, MKFEE = 0.05, START_CAP = 1000;
const WALLET_SINCE = Date.UTC(2026, 9, 30); // 30.10.2026: новые аккаунты начинают с пустым кошельком
// золото за боссов: сколько даётся и сколько раз в день (r3 — Ледяной змей, r4 — Сурт, wb — мировой босс)
const BOSSG = { r3: 1, r4: 3, wb: 1 }, BOSSCAP = { r3: 2, r4: 1, wb: 1 };
const j = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const day = () => Math.floor((Date.now() + 2 * 3600000) / 864e5);
const fail = (code, msg) => { const e = new Error(msg); e.code = code; throw e; };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return j(405, { error: 'POST only' });
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return j(503, { error: 'not_configured' });
  if (admin.initErr && admin.initErr()) return j(500, { error: 'Сервер: ' + admin.initErr() });
  let uid;
  try {
    const tok = (event.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const dec = await admin.auth().verifyIdToken(tok);
    if (!dec.email || !dec.email.endsWith(DOM)) return j(403, { error: 'Нет доступа' });
    uid = dec.email.slice(0, -DOM.length);
  } catch (e) { return j(401, { error: 'Войди в игру заново' }); }

  let q = {};
  try { q = JSON.parse(event.body || '{}'); } catch (e) {}
  const db = admin.firestore();
  const W = id => db.collection('wallet').doc(id);
  const n = Math.floor(+q.n || 0);

  // создать кошелёк при первом обращении: переносим золото из сохранения (не больше START_CAP)
  async function ensure(tx, id) {
    const ref = W(id), sn = await tx.get(ref);
    if (sn.exists) return { ref, w: sn.data() };
    const sv = await tx.get(db.collection('saves').doc(id));
    // перенос золота из сохранения — только для аккаунтов, созданных до серверного кошелька
    let old = false;
    try { const u = await admin.auth().getUserByEmail(id + DOM); old = Date.parse(u.metadata.creationTime) < WALLET_SINCE; } catch (e) {}
    const au = old ? Math.max(0, Math.min(START_CAP, Math.floor((sv.exists && sv.data().au) || 0))) : 0;
    const w = { au, created: Date.now() };
    tx.set(ref, w);
    return { ref, w };
  }
  const logOp = (tx, id, d) => tx.set(W(id).collection('log').doc(Date.now().toString(36) + Math.random().toString(36).slice(2, 6)), { ...d, ts: Date.now() });

  try {
    const out = await db.runTransaction(async tx => {
      const a = q.a;
      if (a === 'get') { const { w } = await ensure(tx, uid); return { au: w.au }; }

      if (a === 'pay') { // любая трата золота
        if (!(n > 0 && n <= 100000)) fail(400, 'Неверная сумма');
        const { ref, w } = await ensure(tx, uid);
        if ((w.au | 0) < n) fail(409, 'Не хватает золота');
        tx.update(ref, { au: w.au - n }); logOp(tx, uid, { op: 'pay', n: -n, why: String(q.why || '').slice(0, 20) });
        return { au: w.au - n };
      }

      if (a === 'xbuy') { // обмен серебра на золото, не больше XLIM в день
        if (!(n > 0 && n <= XLIM)) fail(400, 'Неверная сумма');
        const { ref, w } = await ensure(tx, uid); const d = day();
        const used = w.xd === d ? (w.xn | 0) : 0;
        if (used + n > XLIM) fail(409, `Сегодня можно обменять ещё ${XLIM - used} золота`);
        tx.update(ref, { au: (w.au | 0) + n, xd: d, xn: used + n }); logOp(tx, uid, { op: 'xbuy', n });
        return { au: (w.au | 0) + n, left: XLIM - used - n };
      }

      if (a === 'gift') { // подарок золота от администрации
        if (!ADMINS.includes(uid)) fail(403, 'Только для администрации');
        const to = String(q.to || '');
        if (!/^[a-z0-9_]{3,16}$/.test(to) || !(Math.abs(n) > 0 && Math.abs(n) <= 100000)) fail(400, 'Неверные данные');
        const { ref, w } = await ensure(tx, to);
        const au = Math.max(0, (w.au | 0) + n);
        tx.update(ref, { au }); logOp(tx, to, { op: 'gift', n, by: uid });
        return { ok: true };
      }

      if (a === 'ref') { // награда за приглашённого друга (10 уровень)
        const sv = await tx.get(db.collection('saves').doc(uid));
        const rid = sv.exists ? String(sv.data().ref || '') : '';
        if (!rid || !sv.exists || (sv.data().lvl | 0) < 10) fail(409, 'Нет награды');
        const rref = db.collection('refs').doc(rid).collection('got').doc(uid), rs = await tx.get(rref);
        if (!rs.exists || rs.data().paid) fail(409, 'Нет награды');
        const me = await ensure(tx, uid), him = await ensure(tx, rid);
        tx.update(me.ref, { au: (me.w.au | 0) + REFG }); tx.update(him.ref, { au: (him.w.au | 0) + REFG });
        tx.update(rref, { done: true, doneTs: Date.now(), paid: true });
        logOp(tx, uid, { op: 'ref', n: REFG, from: rid }); logOp(tx, rid, { op: 'ref', n: REFG, friend: uid });
        return { au: (me.w.au | 0) + REFG };
      }

      if (a === 'market') { // покупка лота за золото: деньги сразу уходят продавцу
        const mref = db.collection('market').doc(String(q.id || '')), ms = await tx.get(mref);
        if (!ms.exists) fail(404, 'Лот не найден');
        const m = ms.data();
        if (!m.au || m.sold || m.seller === uid) fail(409, 'Эту вещь уже купили');
        const price = Math.floor(m.price || 0); if (!(price > 0)) fail(400, 'Неверная цена');
        const me = await ensure(tx, uid), sel = await ensure(tx, m.seller);
        if ((me.w.au | 0) < price) fail(409, 'Не хватает золота');
        const g = Math.floor(price * (1 - MKFEE));
        tx.update(me.ref, { au: me.w.au - price }); tx.update(sel.ref, { au: (sel.w.au | 0) + g });
        tx.update(mref, { sold: true, buyer: uid, bname: String(q.name || uid).slice(0, 40), paid: true });
        logOp(tx, uid, { op: 'mbuy', n: -price, lot: mref.id }); logOp(tx, m.seller, { op: 'msell', n: g, lot: mref.id });
        return { au: me.w.au - price, item: m.item };
      }
      if (a === 'boss') { // золото за рейд (Ледяной змей, Сурт) и мирового босса — с дневным лимитом
        const k = String(q.k || ''), id = String(q.id || '');
        if (!/^[A-Za-z0-9_]{1,40}$/.test(id)) fail(400, 'Неверные данные');
        const cref = W(uid).collection('claims').doc(k + '_' + id), cs = await tx.get(cref);
        if (cs.exists) fail(409, 'Награда уже получена');
        let g = 0, cap = 0, key = '';
        if (k === 'raid') {
          const rs = await tx.get(db.collection('raids').doc(id));
          if (!rs.exists) fail(404, 'Рейд не найден');
          const R = rs.data(), m = (R.mem || {})[uid];
          if (R.st !== 'win' || !m || m.bot) fail(409, 'Нет награды');
          if (Object.values(R.mem || {}).filter(x => !x.bot).length < 3) fail(409, 'Золото за рейд — только если в группе от 3 живых воинов');
          key = 'r' + R.b; g = BOSSG[key] || 0; cap = BOSSCAP[key] || 0;
        } else if (k === 'wb') {
          const bs = await tx.get(db.collection('world').doc(id));
          if (!bs.exists) fail(404, 'Босс не найден');
          const B = bs.data();
          if (!B.killed || !((B.dmg || {})[uid] > 0)) fail(409, 'Нет награды');
          const sv = await tx.get(db.collection('saves').doc(uid));
          if (!sv.exists || (sv.data().lvl | 0) < 25) fail(409, 'Мировой босс доступен с 25 уровня');
          key = 'wb'; g = BOSSG.wb; cap = BOSSCAP.wb;
        } else fail(400, 'Неверные данные');
        if (!g) fail(409, 'За этого босса золото не даётся');
        const { ref, w } = await ensure(tx, uid), d = day(), bc = (w.bd === d && w.bc) ? { ...w.bc } : {};
        if ((bc[key] | 0) >= cap) fail(409, 'Дневной лимит золота за этого босса');
        bc[key] = (bc[key] | 0) + 1;
        tx.update(ref, { au: (w.au | 0) + g, bd: d, bc }); tx.set(cref, { ts: Date.now(), g });
        logOp(tx, uid, { op: 'boss', n: g, k, id });
        return { au: (w.au | 0) + g };
      }
      fail(400, 'Неизвестное действие');
    });
    return j(200, out);
  } catch (e) {
    if (e.code && typeof e.code === 'number') return j(e.code, { error: e.message });
    console.error('gold', e); return j(500, { error: 'Ошибка сервера' });
  }
};

// Принимает уведомления Xsolla и зачисляет золото после оплаты.
const crypto = require('crypto');
const admin = require('../lib/fb');
const PACKS = require('../lib/packs');
const { promoNow } = require('../lib/promo');
const err = (code, c, m) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: { code: c, message: m || c } }) });
const ok = { statusCode: 204, body: '' };

function signed(raw, header) {
  const secret = process.env.XSOLLA_WEBHOOK_SECRET || '';
  if (!secret || !header) return false;
  const exp = Buffer.from('Signature ' + crypto.createHash('sha1').update(raw + secret).digest('hex'));
  const got = Buffer.from(String(header).trim());
  return exp.length === got.length && crypto.timingSafeEqual(exp, got);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return err(405, 'METHOD');
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  if (!signed(raw, event.headers.authorization)) return err(400, 'INVALID_SIGNATURE', 'Invalid signature');
  let d;
  try { d = JSON.parse(raw); } catch (e) { return err(400, 'INVALID_PARAMETER', 'Bad JSON'); }
  const db = admin.firestore();
  const t = d.notification_type;

  if (t === 'user_validation') {
    const id = String((d.user && (d.user.id || d.user.external_id)) || '');
    if (!id) return err(400, 'INVALID_USER', 'Invalid user');
    const sn = await db.collection('saves').doc(id).get();
    return sn.exists ? ok : err(400, 'INVALID_USER', 'Invalid user');
  }

  if (t === 'order_paid') {
    const uid = String((d.user && (d.user.external_id || d.user.id)) || '');
    const oid = String((d.order && d.order.id) || '');
    if (!uid || !oid) return err(400, 'INVALID_PARAMETER', 'No user or order');
    const items = (d.items || []).map(i => ({ sku: i.sku, q: i.quantity || 1 }));
    const base = items.reduce((s, i) => s + (PACKS[i.sku] ? PACKS[i.sku].gold * i.q : 0), 0);
    // акция: множитель, зафиксированный при создании заказа; если записи нет — действующая сейчас
    let promo = 1;
    try { const ps = await db.collection('payments').doc(oid).get(); const m = ps.exists ? +ps.data().promo : NaN; promo = m > 1 && m <= 3 ? m : (ps.exists && ps.data().promo != null ? 1 : await promoNow(db)); } catch (e) { promo = 1; }
    const gold = Math.round(base * promo);
    if (gold > 0) {
      const ref = db.collection('pay').doc(uid).collection('orders').doc(oid);
      const log = db.collection('payments').doc(oid);
      await db.runTransaction(async tx => {
        const s = await tx.get(ref);
        if (s.exists) return; // уже зачислено: Xsolla может прислать повторно
        const wref = db.collection('wallet').doc(uid), ws = await tx.get(wref);
        let base = 0;
        if (ws.exists) base = ws.data().au | 0;
        else { const sv = await tx.get(db.collection('saves').doc(uid)); base = Math.max(0, Math.min(1000, Math.floor((sv.exists && sv.data().au) || 0))); }
        tx.set(ref, { gold, base, promo, items, ts: Date.now(), claimed: false });
        if (ws.exists) tx.update(wref, { au: base + gold }); else tx.set(wref, { au: base + gold, created: Date.now() });
        tx.set(wref.collection('log').doc('x' + oid), { op: 'xsolla', n: gold, promo, order: oid, ts: Date.now() });
        tx.set(log, { uid, gold, base, promo, items, status: 'paid', mode: (d.order && d.order.mode) || null,
          amount: (d.order && d.order.amount) || null, currency: (d.order && d.order.currency) || null, paidTs: Date.now() }, { merge: true });
      });
    }
    return ok;
  }

  if (t === 'order_canceled') {
    const oid = String((d.order && d.order.id) || '');
    if (oid) await db.collection('payments').doc(oid).set({ status: 'canceled', cancelTs: Date.now() }, { merge: true });
    return ok;
  }

  return ok; // остальные уведомления просто подтверждаем
};

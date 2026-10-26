// Создаёт заказ в Xsolla и возвращает ссылку на окно оплаты (Pay Station).
const admin = require('../lib/fb');
const PACKS = require('../lib/packs');
const DOM = '@northfall.game';
const j = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return j(405, { error: 'POST only' });
  const PID = process.env.XSOLLA_PROJECT_ID, KEY = process.env.XSOLLA_API_KEY, MID = process.env.XSOLLA_MERCHANT_ID;
  if (!PID || !KEY) return j(500, { error: 'Магазин ещё не настроен' });
  let uid;
  try {
    const tok = (event.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const dec = await admin.auth().verifyIdToken(tok);
    if (!dec.email || !dec.email.endsWith(DOM)) return j(403, { error: 'Нет доступа' });
    uid = dec.email.slice(0, -DOM.length);
  } catch (e) { return j(401, { error: 'Войди в игру заново' }); }

  let req = {};
  try { req = JSON.parse(event.body || '{}'); } catch (e) {}
  const pack = PACKS[req.sku];
  if (!pack) return j(400, { error: 'Неизвестный пакет' });

  const sandbox = process.env.XSOLLA_SANDBOX !== '0';
  const site = process.env.URL || 'https://amazing-pie-3b396b.netlify.app';
  const body = {
    user: { id: { value: uid }, name: { value: String(req.name || uid).slice(0, 40) } },
    purchase: { items: [{ sku: req.sku, quantity: 1 }] },
    sandbox,
    settings: { language: 'ru', return_url: site + '/?paid=1' },
    custom_parameters: { login: uid }
  };
  const url = `https://store.xsolla.com/api/v3/project/${PID}/admin/payment/token`;
  const call = (id) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${id}:${KEY}`).toString('base64') },
    body: JSON.stringify(body)
  });
  let r = await call(PID);
  if ((r.status === 401 || r.status === 403) && MID) r = await call(MID);
  const out = await r.json().catch(() => ({}));
  if (!r.ok || !out.token) {
    console.error('xsolla token error', r.status, JSON.stringify(out));
    return j(502, { error: 'Xsolla: ' + (out.errorMessage || out.message || r.status) });
  }
  try {
    if (out.order_id) await admin.firestore().collection('payments').doc(String(out.order_id))
      .set({ uid, sku: req.sku, gold: pack.gold, status: 'created', sandbox, ts: Date.now() }, { merge: true });
  } catch (e) { console.error('payments log', e); }
  const host = sandbox ? 'https://sandbox-secure.xsolla.com' : 'https://secure.xsolla.com';
  return j(200, { url: `${host}/paystation4/?token=${out.token}`, order: out.order_id || null });
};

// Создаёт заказ в Xsolla и возвращает ссылку на окно оплаты (Pay Station).
const admin = require('../lib/fb');
const PACKS = require('../lib/packs');
const { promoNow } = require('../lib/promo');
const DOM = '@northfall.game';
const j = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

exports.handler = async (event) => { try { return await main(event); } catch (e) { console.error('token crash', e); return j(500, { error: 'Сервер: ' + (e.message || 'сбой') }); } };
async function main(event) {
  if (event.httpMethod !== 'POST') return j(405, { error: 'POST only' });
  const PID = process.env.XSOLLA_PROJECT_ID, KEY = process.env.XSOLLA_API_KEY, MID = process.env.XSOLLA_MERCHANT_ID;
  if (!PID || !KEY) return j(500, { error: 'Магазин ещё не настроен' });
  if (admin.initErr && admin.initErr()) return j(500, { error: 'Сервер: ' + admin.initErr() });
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
  const site = process.env.URL || 'https://playnorthfall.online';
  const body = {
    user: { id: { value: uid }, name: { value: String(req.name || uid).slice(0, 40) } },
    purchase: { items: [{ sku: req.sku, quantity: 1 }] },
    sandbox,
    settings: { language: req.lg === 'en' ? 'en' : 'ru', return_url: site + (req.lg === 'en' ? '/en/?paid=1' : '/?paid=1') },
    custom_parameters: { login: uid }
  };
  // Xsolla требует страну игрока или его IP: берём их из заголовков Netlify
  const h = event.headers || {};
  const rawIp = (h['fly-client-ip'] || h['x-nf-client-connection-ip'] || h['client-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || '').trim();
  // Xsolla принимает в X-User-Ip только IPv4: IPv6 (у многих мобильных сетей) она не понимает и страну не определяет
  const m4 = rawIp.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  const ip = m4 && !rawIp.replace(m4[1], '').replace(/[:f]/gi, '') ? m4[1] : '';
  let cc = (h['x-country'] || '').trim().toUpperCase();
  if (!cc && h['x-nf-geo']) { try { cc = (JSON.parse(Buffer.from(h['x-nf-geo'], 'base64').toString()).country || {}).code || ''; } catch (e) {} }
  // нет страны и нет IPv4: берём регион из языка браузера (ru-IL → IL), иначе US; игрок сможет сменить страну в окне оплаты
  if (!/^[A-Z]{2}$/.test(cc) && !ip) {
    const al = String(h['accept-language'] || '').split(',').map(x => (x.trim().match(/^[a-z]{2,3}[-_]([A-Za-z]{2})\b/) || [])[1]).find(Boolean);
    cc = al ? al.toUpperCase() : 'US';
  }
  if (/^[A-Z]{2}$/.test(cc)) body.user.country = { value: cc, allow_modify: true };
  const url = `https://store.xsolla.com/api/v3/project/${PID}/admin/payment/token`;
  const call = (id) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ip ? { 'X-User-Ip': ip } : {}), Authorization: 'Basic ' + Buffer.from(`${id}:${KEY}`).toString('base64') },
    body: JSON.stringify(body)
  });
  let r = await call(PID);
  if ((r.status === 401 || r.status === 403) && MID) r = await call(MID);
  const out = await r.json().catch(() => ({}));
  if (!r.ok || !out.token) {
    console.error('xsolla token error', r.status, JSON.stringify(out));
    return j(502, { error: 'Xsolla: ' + (out.errorMessage || out.message || r.status) });
  }
  const promo = await promoNow(admin.firestore()); // акция фиксируется в момент покупки
  try {
    if (out.order_id) await admin.firestore().collection('payments').doc(String(out.order_id))
      .set({ uid, sku: req.sku, gold: Math.round(pack.gold * promo), base: pack.gold, promo, status: 'created', sandbox, ts: Date.now() }, { merge: true });
  } catch (e) { console.error('payments log', e); }
  const host = sandbox ? 'https://sandbox-secure.xsolla.com' : 'https://secure.xsolla.com';
  return j(200, { url: `${host}/paystation4/?token=${out.token}`, order: out.order_id || null });
}

// Отправка уведомлений на телефон (Web Push). Ключи VAPID создаются один раз и хранятся в priv/_vapid.
const webpush = require('web-push');
let VAP = null;
async function vapid(db) {
  if (VAP) return VAP;
  const ref = db.collection('priv').doc('_vapid'), sn = await ref.get();
  let k = sn.exists ? sn.data() : null;
  if (!k || !k.publicKey || !k.privateKey) { k = webpush.generateVAPIDKeys(); await ref.set(k); }
  webpush.setVapidDetails('mailto:admin@playnorthfall.online', k.publicKey, k.privateKey);
  VAP = k; return k;
}
// kind: en | msg | raid | wb — игрок может отключить любой вид
async function sendTo(db, uid, kind, payload) {
  const ref = db.collection('push').doc(uid), sn = await ref.get();
  if (!sn.exists) return false;
  const P = sn.data();
  if (!P.sub || (P.off || []).includes(kind)) return false;
  await vapid(db);
  try {
    await webpush.sendNotification(P.sub, JSON.stringify(payload), { TTL: 6 * 3600 });
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) await ref.set({ sub: null }, { merge: true });
    else console.error('push', uid, e.statusCode || e.message);
    return false;
  }
}
module.exports = { vapid, sendTo };

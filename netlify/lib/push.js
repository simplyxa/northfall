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
// английские уведомления для игроков английской версии
const PEN = [
  [/^Northfall: новое сообщение$/, 'Northfall: new message'], [/^(.+) написал тебе$/, '$1 sent you a message'],
  [/^Northfall: вызов на лайв-арену!$/, 'Northfall: live arena challenge!'], [/^(.+) вызывает тебя на дуэль\. 2 минуты на ответ!$/, '$1 challenges you to a duel. 2 minutes to answer!'],
  [/^Northfall: приглашение в клан$/, 'Northfall: clan invitation'], [/^(.+) зовёт тебя в клан «(.*)»$/, '$1 invites you to the clan «$2»'],
  [/^Northfall: пишут в общем чате$/, 'Northfall: new in general chat'],
  [/^Northfall: рейд собран!$/, 'Northfall: raid assembled!'], [/^Группа готова — бой начинается\. Ход 10 секунд!$/, 'The group is ready — the battle begins!'],
  [/^Northfall: энергия полна ⚡$/, 'Northfall: energy full ⚡'], [/^Звери в Чаще заждались\. Самое время на охоту!$/, 'The beasts in the Thicket are waiting. Time to hunt!'],
  [/^Northfall: (.+) ждёт$/, 'Northfall: $1 awaits'], [/^Мировой босс ещё жив\. Удар раз в час — успей до полуночи!$/, 'The world boss is still alive. One strike an hour — make it before midnight!'],
  [/^Northfall: Лайв-арена открыта ⚔$/, 'Northfall: live arena is open ⚔'], [/^Бои 1 на 1 с живыми игроками — только до 20:00 по Москве\. Заходи!$/, '1-on-1 battles with real players — only until 20:00 Moscow time. Join in!'],
];
const BEN = { 'Фенрир': 'Fenrir', 'Хати': 'Hati', 'Скёль': 'Sköll', 'Хрунгнир': 'Hrungnir', 'Тиацци': 'Thiazi', 'Нидхёгг': 'Níðhöggr', 'Гарм': 'Garm' };
function toEn(p) {
  const tr = s => { if (typeof s !== 'string') return s; for (const [re, to] of PEN) if (re.test(s)) { s = s.replace(re, to); break; } for (const k in BEN) s = s.split(k).join(BEN[k]); return s; };
  const u = typeof p.u === 'string' && p.u.startsWith('/') && !p.u.startsWith('/en/') ? '/en' + p.u : p.u;
  return Object.assign({}, p, { t: tr(p.t), b: tr(p.b), u });
}
async function sendTo(db, uid, kind, payload) {
  const ref = db.collection('push').doc(uid), sn = await ref.get();
  if (!sn.exists) return false;
  const P = sn.data();
  if (!P.sub || (P.off || []).includes(kind)) return false;
  await vapid(db);
  if (P.lg === 'en') payload = toEn(payload);
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

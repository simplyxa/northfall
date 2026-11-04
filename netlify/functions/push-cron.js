// Раз в 15 минут: «энергия восстановлена»; в 19:00 по Израилю — напоминание о мировом боссе.
const admin = require('../lib/fb');
const { sendTo } = require('../lib/push');
const WBN = ['Фенрир', 'Хати', 'Скёль', 'Хрунгнир', 'Тиацци', 'Нидхёгг', 'Гарм'];
const day = () => Math.floor((Date.now() + 2 * 3600000) / 864e5);

exports.handler = async () => {
  if (admin.initErr && admin.initErr()) { console.error(admin.initErr()); return { statusCode: 500 }; }
  const db = admin.firestore(), now = Date.now();
  let n = 0;
  // энергия
  const en = await db.collection('push').where('enAt', '>', 0).where('enAt', '<=', now).limit(300).get();
  for (const d of en.docs) {
    const P = d.data();
    if (P.enAt > (P.st || 0) + 864e5) continue;
    await d.ref.set({ enAt: 0 }, { merge: true });
    if (await sendTo(db, d.id, 'en', { t: 'Northfall: энергия полна ⚡', b: 'Звери в Чаще заждались. Самое время на охоту!', tag: 'en', u: '/?go=hunt' })) n++;
  }
  // мировой босс: один раз в день, около 19:00 по Израилю (17:00 UTC)
  const h = new Date(now + 2 * 3600000).getUTCHours(), D = day();
  if (h === 19) {
    const w = await db.collection('world').doc('b' + D).get();
    const B = w.exists ? w.data() : null;
    if (!B || !B.killed) {
      const ps = await db.collection('push').where('lvl', '>=', 25).limit(500).get();
      for (const d of ps.docs) {
        const P = d.data();
        if ((P.wbDay | 0) === D || (P.wbRem | 0) === D) continue;
        await d.ref.set({ wbRem: D }, { merge: true });
        if (await sendTo(db, d.id, 'wb', { t: `Northfall: ${WBN[D % 7]} ждёт`, b: 'Мировой босс ещё жив. Удар раз в час — успей до полуночи!', tag: 'wb', u: '/?go=boss' })) n++;
      }
    }
  }
  // Лайв-арена: открывается в 19:00 МСК (16:00 UTC) — один раз в день оповещение всем с 5 уровня + запись в общий чат
  const u = new Date(now);
  if (u.getUTCHours() === 16) {
    const LD = Math.floor(now / 864e5), fl = db.collection('priv').doc('la-notify'), fs = await fl.get();
    if (!fs.exists || (fs.data().day | 0) !== LD) {
      await fl.set({ day: LD, ts: now });
      await db.collection('chat').doc('n' + now.toString(36) + 'la').set({ uid: 'admin', name: 'Администрация', sys: 1, ts: now,
        text: '⚔ Лайв-арена открыта! Бои 1 на 1 с живыми игроками до 20:00 по Москве. Главная → Лайв-арена.' });
      const ps = await db.collection('push').where('lvl', '>=', 5).limit(500).get();
      for (const d of ps.docs) {
        if ((d.data().laDay | 0) === LD) continue;
        await d.ref.set({ laDay: LD }, { merge: true });
        if (await sendTo(db, d.id, 'la', { t: 'Northfall: Лайв-арена открыта ⚔', b: 'Бои 1 на 1 с живыми игроками — только до 20:00 по Москве. Заходи!', tag: 'la', u: '/?go=duel' })) n++;
      }
    }
  }
  console.log('push-cron sent', n);
  return { statusCode: 200 };
};

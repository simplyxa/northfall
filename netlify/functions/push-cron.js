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
  console.log('push-cron sent', n);
  return { statusCode: 200 };
};

// Срабатывает после каждой успешной выкладки сайта (событие Netlify deploy-succeeded).
// Пишет на форум в тему «Обновления игры» короткий список изменений из netlify/lib/changelog.json,
// которые ещё не публиковались, и коротко сообщает об обновлении в общем чате.
const admin = require('../lib/fb');
const LOG = require('../lib/changelog.json');
const TID = 'tupdates';
const NAME = 'Администрация';

exports.handler = async (event) => {
  try {
    let ctx = 'production';
    try { const b = JSON.parse(event.body || '{}'); ctx = (b.payload && b.payload.context) || ctx; } catch (e) {}
    if (ctx !== 'production') return { statusCode: 200, body: 'skip ' + ctx };
    if (admin.initErr && admin.initErr()) return { statusCode: 200, body: 'no firebase' };
    const db = admin.firestore();
    const st = db.collection('priv').doc('changelog-state');
    const done = new Set(((await st.get()).data() || {}).posted || []);
    const fresh = LOG.filter(x => x && x.v && x.t && !done.has(x.v));
    if (!fresh.length) return { statusCode: 200, body: 'nothing new' };

    const ts = Date.now();
    const date = new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Asia/Jerusalem' });
    const vs = fresh.length > 1 ? `версии ${fresh[0].v}–${fresh[fresh.length - 1].v}` : `версия ${fresh[0].v}`;
    const text = `Обновление ${date} (${vs}):\n\n` + fresh.map(x => '• ' + x.t).join('\n');

    const tref = db.collection('forum').doc(TID);
    const ts0 = await tref.get();
    if (!ts0.exists) {
      await tref.set({ sec: 'news', title: 'Обновления игры', uid: 'admin', name: NAME, ts, last: ts, lastn: NAME, cnt: 0, pinned: true, closed: true });
      await tref.collection('posts').doc('p0000').set({ uid: 'admin', name: NAME, ts: ts - 1,
        text: 'В этой теме коротко пишем обо всём, что появилось в игре. Обновления выходят по ночам. Идеи и ошибки пишите в разделах «Общий зал» и «Помощь новичкам» или через «Сообщить об ошибке».' });
    }
    await tref.collection('posts').doc('u' + ts.toString(36)).set({ uid: 'admin', name: NAME, text: text.slice(0, 2000), ts });
    const cnt = ((ts0.exists && ts0.data().cnt) | 0) + (ts0.exists ? 1 : 2);
    await tref.set({ last: ts, lastn: NAME, cnt }, { merge: true });
    // английская тема обновлений: только записи с переводом (поле te)
    const fe = fresh.filter(x => x.te);
    let fte = '';
    if (fe.length) {
      const eref = db.collection('forum').doc(TID + '_en'), e0 = await eref.get();
      const dEn = new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Asia/Jerusalem' });
      const vEn = fe.length > 1 ? `versions ${fe[0].v}–${fe[fe.length - 1].v}` : `version ${fe[0].v}`;
      if (!e0.exists) {
        await eref.set({ sec: 'news', title: 'Game updates (English)', uid: 'admin', name: 'Administration', ts, last: ts, lastn: 'Administration', cnt: 0, pinned: true, closed: true, lg: 'en' });
        await eref.collection('posts').doc('p0000').set({ uid: 'admin', name: 'Administration', ts: ts - 1, text: 'Short notes about everything new in the game. Post ideas and bugs in «Great hall», «Help for newcomers» or via «Report a bug».' });
      }
      await eref.collection('posts').doc('u' + ts.toString(36)).set({ uid: 'admin', name: 'Administration', text: (`Update ${dEn} (${vEn}):\n\n` + fe.map(x => '• ' + x.te).join('\n')).slice(0, 2000), ts });
      await eref.set({ last: ts, lastn: 'Administration', cnt: ((e0.exists && e0.data().cnt) | 0) + (e0.exists ? 1 : 2) }, { merge: true });
      fte = TID + '_en';
    }
    await db.collection('chat').doc('n' + ts.toString(36) + 'upd').set({ uid: 'admin', name: NAME, sys: 1, ts,
      ft: TID, ...(fte ? { fte } : {}),
      text: `Вышло обновление (${vs}). Что нового — на форуме в теме «Обновления игры».` });
    // копия в Discord-канал новостей (вебхук канала задаётся секретом DISCORD_WEBHOOK)
    const hook = (process.env.DISCORD_WEBHOOK || '').trim();
    if (/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(hook)) {
      try {
        const body = { username: 'Northfall', allowed_mentions: { parse: [] }, embeds: [{
          title: `Обновление ${date} (${vs})`, url: 'https://playnorthfall.online/', color: 0x8b5cf6,
          description: (fresh.map(x => '• ' + x.t).join('\n')).slice(0, 3900) + '\n\n[Играть →](https://playnorthfall.online/)' }] };
        const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        console.log('discord', r.status);
      } catch (e) { console.error('discord', e.message); }
    }
    await st.set({ posted: [...done, ...fresh.map(x => x.v)].slice(-300), lastTs: ts }, { merge: true });
    return { statusCode: 200, body: 'posted ' + fresh.length };
  } catch (e) {
    console.error('deploy-succeeded', e);
    return { statusCode: 200, body: 'error' };
  }
};

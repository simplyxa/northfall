// Почта для восстановления пароля и сброс пароля по почте.
// Почта игрока хранится в priv/{логин} — читать и менять её может только сервер.
// Письма отправляются через Resend (переменная RESEND_API_KEY в Netlify).
const admin = require('../lib/fb');
const DOM = '@northfall.game';
const FROM = process.env.MAIL_FROM || 'Northfall <noreply@playnorthfall.online>';
const RESET_GAP = 10 * 60 * 1000; // не чаще одного письма в 10 минут на логин
const j = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const MAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const mask = m => { const [u, d] = String(m).split('@'); return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***' + u.slice(-1)) + '@' + d; };

async function sendMail(to, subject, html, text) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.RESEND_API_KEY },
    body: JSON.stringify({ from: FROM, to: [to], subject, html, text })
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('mail ' + r.status + ' ' + t.slice(0, 200)); }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return j(405, { error: 'POST only' });
    if (admin.initErr && admin.initErr()) return j(500, { error: 'Сервер: ' + admin.initErr() });
    let q = {}; try { q = JSON.parse(event.body || '{}'); } catch (e) {}
    const db = admin.firestore();

    // Сброс пароля: без входа в игру. Ответ всегда одинаковый, чтобы нельзя было узнать чужую почту.
    if (q.a === 'reset') {
      if (!process.env.RESEND_API_KEY) return j(503, { error: 'Восстановление пароля пока не настроено. Напиши на admin@playnorthfall.online.' });
      const id = String(q.login || '').trim().toLowerCase();
      const ok = j(200, { ok: true, msg: 'Если к этому логину привязана почта, письмо со ссылкой уже отправлено. Проверь и папку «Спам».' });
      if (!/^[a-z0-9_]{3,16}$/.test(id)) return ok;
      const ref = db.collection('priv').doc(id), sn = await ref.get();
      if (!sn.exists || !sn.data().email) return ok;
      const P = sn.data();
      if (Date.now() - (P.resetTs || 0) < RESET_GAP) return ok;
      await ref.set({ resetTs: Date.now() }, { merge: true });
      let link;
      try { link = await admin.auth().generatePasswordResetLink(id + DOM); } catch (e) { console.error('reset link', e.message); return ok; }
      const html = `<div style="font-family:Georgia,serif;font-size:16px;line-height:1.5;color:#222">
<h2 style="margin:0 0 12px">Northfall: Barbarians</h2>
<p>Кто-то (надеемся, ты) попросил сбросить пароль героя <b>${id}</b>.</p>
<p><a href="${link}" style="display:inline-block;background:#c79a3c;color:#140f08;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Задать новый пароль</a></p>
<p style="color:#666;font-size:14px">Ссылка действует 1 час. Если ты не просил сброс — просто удали это письмо, пароль останется прежним.</p>
<p style="color:#666;font-size:14px">Вход в игру: логин <b>${id}</b> и новый пароль на <a href="https://playnorthfall.online">playnorthfall.online</a></p></div>`;
      const text = `Northfall: Barbarians\n\nСброс пароля героя ${id}.\nЗадать новый пароль: ${link}\n\nСсылка действует 1 час. Если ты не просил сброс — удали письмо.`;
      try { await sendMail(P.email, 'Сброс пароля — Northfall', html, text); } catch (e) { console.error(e.message); return j(502, { error: 'Не удалось отправить письмо. Попробуй позже.' }); }
      return ok;
    }

    // Остальное — только для вошедшего игрока
    let uid;
    try {
      const tok = (event.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const dec = await admin.auth().verifyIdToken(tok);
      if (!dec.email || !dec.email.endsWith(DOM)) return j(403, { error: 'Нет доступа' });
      uid = dec.email.slice(0, -DOM.length);
    } catch (e) { return j(401, { error: 'Войди в игру заново' }); }
    const ref = db.collection('priv').doc(uid);

    if (q.a === 'getmail') { const sn = await ref.get(); const m = sn.exists && sn.data().email; return j(200, { email: m ? mask(m) : '' }); }

    if (q.a === 'setmail') {
      const m = String(q.email || '').trim().toLowerCase();
      if (m && !MAIL_RE.test(m)) return j(400, { error: 'Похоже, в почте ошибка.' });
      await ref.set({ email: m, mailTs: Date.now() }, { merge: true });
      return j(200, { email: m ? mask(m) : '' });
    }
    return j(400, { error: 'Неизвестное действие' });
  } catch (e) { console.error('account', e); return j(500, { error: 'Ошибка сервера' }); }
};

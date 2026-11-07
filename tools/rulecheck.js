// Проверка опубликованных правил Firestore и сквозной сценарий игры.
// Запуск: node tools/rulecheck.js [домен]
//
// Что проверяет:
//  1. запись в saves запрещена — серверную проверку экономики нельзя обойти;
//  2. запись в market запрещена — цену лота нельзя подменить;
//  3. запись в players разрешена (карточка игрока пока клиентская);
//  4. чтение своего сохранения работает — правила валидны, игра не сломана;
//  5. POST /api/save проходит и сохранение реально попадает в базу;
//  6. клиент читает сохранение обратно.
//
// Работает через клиентский SDK в браузере — тем же путём, которым писал бы
// игрок из консоли. Тестовый аккаунт и его документы удаляются в конце.
'use strict';
const { chromium } = (() => {
  const cands = ['playwright', '/usr/local/lib/node_modules/playwright/index.mjs'];
  for (const c of cands) { try { return require(c); } catch (e) {} }
  console.log('Нужен playwright: npm i -g playwright && npx playwright install chromium');
  process.exit(2);
})();

const DOMAIN = process.argv[2] || 'https://playnorthfall.online';
const EXEC = process.env.CHROME_PATH || '/root/.cache/ms-playwright/chromium-1243/chrome-linux/chrome';
const EMAIL = 'zz_check_' + Date.now().toString(36).slice(-6) + '@northfall.game';
const PW = 'Chk-' + Math.random().toString(36).slice(2) + '!x';

let failed = 0;
const c = (k, pass, note) => { if (!pass) failed++; console.log('  ' + (pass ? '✓' : '✗') + ' ' + k + (note ? ' — ' + note : '')); };

(async function () {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const p = await b.newPage();
  await p.goto(DOMAIN + '/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await p.waitForTimeout(4500);

  const res = await p.evaluate(async ({ email, pw }) => {
    const out = {};
    const login = email.split('@')[0];      // в игре документы адресуются по префиксу почты
    const user = await firebase.auth().createUserWithEmailAndPassword(email, pw).then(r => r.user).catch(async e => {
      if (e.code === 'auth/email-already-in-use') return firebase.auth().signInWithEmailAndPassword(email, pw).then(r => r.user);
      out.auth = e.code + ': ' + e.message; return null;
    });
    if (!user) return out;
    out.login = login;
    const db = firebase.firestore();
    const write = async (path, data, merge) => {
      try { await db.doc(path).set(data, merge ? { merge: true } : undefined); return 'ЗАПИСЬ ПРОШЛА'; }
      catch (e) { return e.code || (e.message || '').slice(0, 80); }
    };
    out.saves = await write('saves/' + login, { lvl: 1, gold: 999999, inv: [], ts: Date.now() });
    // первое сохранение — обычное, задаёт линию сессий
    try {
      const r = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await user.getIdToken() },
        body: JSON.stringify({ s: { lvl: 1, xp: 0, gold: 30, au: 0, inv: [], eq: {}, ts: Date.now(), ses: 'probe1' }, ses: 'probe1', base: null })
      });
      out.saveStatus = r.status;
    } catch (e) { out.saveStatus = 'ошибка ' + e.message; }
    // подделка рейтинга в сохранении: сервер должен её проигнорировать
    try {
      const r = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await user.getIdToken() },
        body: JSON.stringify({ s: { lvl: 1, xp: 0, gold: 30, au: 0, inv: [], eq: {}, ts: Date.now(), ses: 'probe1', rating: 99999, srat: 99999 }, ses: 'probe1', base: null })
      });
      const j = await r.json().catch(() => ({}));
      out.fix = j.fix || null;
    } catch (e) { out.fix = 'ошибка ' + e.message; }
    // а теперь честная заявка на победу: +22 к рейтингу
    try {
      const r = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await user.getIdToken() },
        body: JSON.stringify({ s: { lvl: 1, xp: 0, gold: 30, au: 0, inv: [], eq: {}, ts: Date.now(), ses: 'probe1', rating: 1022, srat: 22, ar: { d: 22 } }, ses: 'probe1', base: 'probe1' })
      });
      const j = await r.json().catch(() => ({}));
      out.fix2 = j.fix || null;
    } catch (e) { out.fix2 = 'ошибка ' + e.message; }
    await new Promise(r => setTimeout(r, 1200));
    try { const s = await db.doc('saves/' + login).get(); out.savedRating = s.exists ? (s.data().rating | 0) : 'нет'; }
    catch (e) { out.savedRating = 'ошибка: ' + e.code; }
    try { const s = await db.doc('players/' + login).get(); out.cardRating = s.exists ? (s.data().rating | 0) : 'нет'; }
    catch (e) { out.cardRating = 'ошибка: ' + e.code; }
    out.market = await write('market/probe_' + Date.now().toString(36), { seller: login, price: 1, sold: false });
    // карточка игрока: с рейтингом — запрещено, без защищённых полей — можно (так пишет клиент)
    // 1) создание карточки (документа ещё нет) — клиент так и пишет в первый раз
    out.playersCreate = await write('players/' + login, { name: 'check', lvl: 1, tst: 1 }, true);
    // 2) правка чужого рейтинга — запрещена
    out.playersBad = await write('players/' + login, { name: 'check', lvl: 1, rating: 99999, win: 9999 }, true);
    // 3) обычная правка карточки (имя, аватар) — разрешена
    out.playersOk = await write('players/' + login, { name: 'check2', tst: 1 }, true);
    await new Promise(r => setTimeout(r, 1500));
    try { const s = await db.doc('saves/' + login).get(); out.saveInDb = s.exists ? 'да, gold=' + (s.data().gold) : 'НЕТ'; }
    catch (e) { out.saveInDb = 'ошибка чтения: ' + e.code; }
    try { const s = await db.doc('saves/' + login).get(); out.clientRead = s.exists ? 'ок' : 'нет документа'; }
    catch (e) { out.clientRead = 'ошибка: ' + e.code; }
    // уборка: карточка и сохранение обязаны исчезнуть, иначе профиль останется в рейтинге
    try { await db.doc('saves/' + login).delete(); } catch (e) {}
    let cardGone = false;
    try {
      await db.doc('players/' + login).delete();
      await new Promise(r => setTimeout(r, 400));
      const left = await db.doc('players/' + login).get();
      cardGone = !left.exists;
    } catch (e) { out.cardDel = 'ошибка удаления: ' + e.code; }
    out.cardGone = cardGone;
    try { await user.delete(); out.cleanup = 'аккаунт удалён'; } catch (e) { out.cleanup = 'не удалён: ' + e.code; }
    return out;
  }, { email: EMAIL, pw: PW });

  console.log('\nПроверка правил Firestore и игры: ' + DOMAIN + '\n');
  console.log('  игрок: ' + (res.login || res.auth || 'не создан'));
  c('запись в saves запрещена (серверную проверку не обойти)', res.saves === 'permission-denied', res.saves || 'нет данных');
  c('запись в market запрещена (цену лота не подменить)', res.market === 'permission-denied', res.market || 'нет данных');
  c('создание карточки разрешено', res.playersCreate === 'ЗАПИСЬ ПРОШЛА', res.playersCreate || 'нет данных');
  c('запись рейтинга в карточку запрещена', res.playersBad === 'permission-denied', res.playersBad || 'нет данных');
  c('запись остальных полей карточки разрешена', res.playersOk === 'ЗАПИСЬ ПРОШЛА', res.playersOk || 'нет данных');
  c('POST /api/save принят сервером', res.saveStatus === 200, 'HTTP ' + res.saveStatus);
  c('сохранение попало в базу', res.saveInDb === 'да, gold=30', res.saveInDb);
  c('клиент читает своё сохранение', res.clientRead === 'ок', res.clientRead);
  c('подделка рейтинга проигнорирована (сервер оставил 1000)', res.fix && res.fix.rating === 1000, res.fix ? 'рейтинг сервера: ' + res.fix.rating : 'нет данных');
  c('честная заявка засчитана (1000 → 1022)', res.fix2 && res.fix2.rating === 1022, res.fix2 ? 'рейтинг сервера: ' + res.fix2.rating : 'нет данных');
  c('в сохранении лежит серверный рейтинг', res.savedRating === 1022, 'рейтинг=' + res.savedRating);
  c('в карточке игрока тот же рейтинг', res.cardRating === 1022, 'рейтинг=' + res.cardRating);
  c('тестовая карточка удалена (не светится в рейтинге)', res.cardGone === true, res.cardGone === false ? ('осталась: ' + (res.cardDel || 'delete прошёл, но документ на месте')) : String(res.cardGone));
  c('тестовый аккаунт удалён', res.cleanup === 'аккаунт удалён', res.cleanup);
  console.log(failed ? '\n  есть проблемы: ' + failed + '\n' : '\n  всё в порядке\n');
  await b.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ОШИБКА:', e); process.exit(1); });

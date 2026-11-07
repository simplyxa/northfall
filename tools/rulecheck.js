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
    const write = async (path, data) => {
      try { await db.doc(path).set(data); return 'ЗАПИСЬ ПРОШЛА'; }
      catch (e) { return e.code || (e.message || '').slice(0, 80); }
    };
    out.saves = await write('saves/' + login, { lvl: 1, gold: 999999, inv: [], ts: Date.now() });
    out.market = await write('market/probe_' + Date.now().toString(36), { seller: login, price: 1, sold: false });
    out.players = await write('players/' + login, { name: 'check', lvl: 1 });
    // сквозной сценарий: сохранение через сервер игры
    try {
      const r = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await user.getIdToken() },
        body: JSON.stringify({ s: { lvl: 1, xp: 0, gold: 30, au: 0, inv: [], eq: {}, ts: Date.now(), ses: 'probe1' }, ses: 'probe1', base: null })
      });
      out.saveStatus = r.status;
    } catch (e) { out.saveStatus = 'ошибка ' + e.message; }
    await new Promise(r => setTimeout(r, 1500));
    try { const s = await db.doc('saves/' + login).get(); out.saveInDb = s.exists ? 'да, gold=' + (s.data().gold) : 'НЕТ'; }
    catch (e) { out.saveInDb = 'ошибка чтения: ' + e.code; }
    try { const s = await db.doc('saves/' + login).get(); out.clientRead = s.exists ? 'ок' : 'нет документа'; }
    catch (e) { out.clientRead = 'ошибка: ' + e.code; }
    // уборка
    try { await db.doc('saves/' + login).delete(); } catch (e) {}
    try { await db.doc('players/' + login).delete(); } catch (e) {}
    try { await user.delete(); out.cleanup = 'аккаунт удалён'; } catch (e) { out.cleanup = 'не удалён: ' + e.code; }
    return out;
  }, { email: EMAIL, pw: PW });

  console.log('\nПроверка правил Firestore и игры: ' + DOMAIN + '\n');
  console.log('  игрок: ' + (res.login || res.auth || 'не создан'));
  c('запись в saves запрещена (серверную проверку не обойти)', res.saves === 'permission-denied', res.saves || 'нет данных');
  c('запись в market запрещена (цену лота не подменить)', res.market === 'permission-denied', res.market || 'нет данных');
  c('запись в players разрешена (карточка пока клиентская)', res.players === 'ЗАПИСЬ ПРОШЛА', res.players || 'нет данных');
  c('POST /api/save принят сервером', res.saveStatus === 200, 'HTTP ' + res.saveStatus);
  c('сохранение попало в базу', res.saveInDb === 'да, gold=30', res.saveInDb);
  c('клиент читает своё сохранение', res.clientRead === 'ок', res.clientRead);
  c('тестовый аккаунт и документы удалены', res.cleanup === 'аккаунт удалён', res.cleanup);
  console.log(failed ? '\n  есть проблемы: ' + failed + '\n' : '\n  всё в порядке\n');
  await b.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ОШИБКА:', e); process.exit(1); });

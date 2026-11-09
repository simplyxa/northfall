#!/usr/bin/env node
'use strict';
// Интеграционный тест: настоящий обработчик сохранений server/saves.js поверх слоя pgdocs/PostgreSQL.
// Firebase Auth подменён (токен = логин). Нужен DATABASE_URL (или NODE_PATH=tools/pgshim) и таблица fs_docs.
const pg = require('../server/pg');
const docs = require('../server/pgdocs');
const saves = require('../server/saves');
let ok = 0, bad = 0;
const T = (n, c, x) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (x ? ' — ' + x : '')); } };
const admin = { auth: () => ({ verifyIdToken: async t => ({ email: t + '@northfall.game' }) }), firestore: docs.firestore };
const H = saves(() => admin);
const call = (fn, tok, body) => new Promise(r => {
  const res = { writeHead(c) { this.c = c; }, end(b) { let j = null; try { j = JSON.parse(b); } catch (e) {} r({ code: this.c, body: j }); } };
  fn({ headers: { authorization: 'Bearer ' + tok } }, res, Buffer.from(JSON.stringify(body)));
});
const hero = (o) => Object.assign({ name: 'ZTest', lvl: 5, gold: 100, iron: 1, xp: 0, st: { str: 10, hp: 10, arm: 5, reg: 5, en: 5 }, inv: [], eq: {}, hp: 100, ts: Date.now() }, o || {});
(async () => {
  const db = docs.firestore();
  await pg.query("DELETE FROM fs_docs WHERE id LIKE 'ztestu%'");
  console.log('\nСохранения на Postgres:');
  let r = await call(H, 'ztestu1', { s: hero(), ses: 'S1' });
  T('первое сохранение принято', r.code === 200, JSON.stringify(r));
  const sv = await db.collection('saves').doc('ztestu1').get();
  T('сохранение лежит в fs_docs', sv.exists && sv.data().name === 'ZTest' && sv.data().ses === 'S1');
  const pc = await db.collection('players').doc('ztestu1').get();
  T('публичная карточка игрока записана сервером', pc.exists && pc.data().lvl === 5);
  r = await call(H, 'ztestu1', { s: hero({ gold: 120 }), ses: 'S1' });
  T('повторное сохранение той же линии', r.code === 200);
  r = await call(H, 'ztestu1', { s: hero(), ses: 'OTHER', base: 'WRONG' });
  T('чужая линия сохранений отклонена (409)', r.code === 409, JSON.stringify(r));
  r = await call(H, 'nobody', { s: { inv: 'x' }, ses: 'S' });
  T('кривое сохранение отклонено', r.code === 400);
  r = await call(H, 'ztestu1', { s: hero({ gold: 9999999 }), ses: 'S1' });
  const g = (await db.collection('saves').doc('ztestu1').get()).data().gold;
  T('копилка серебра урезает накрутку', r.code === 200 && g < 9999999, 'gold=' + g);
  r = await call(H, 'ztestu1', { s: hero({ lvl: 60 }), ses: 'S1' });
  T('прыжок уровня урезается', (await db.collection('saves').doc('ztestu1').get()).data().lvl <= 15);
  const rs = await Promise.all(Array.from({ length: 12 }, () => call(H, 'ztestu2', { s: hero({ name: 'ZTest2' }), ses: 'S2' })));
  T('12 параллельных сохранений одного игрока: без ошибок', rs.every(x => x.code === 200), rs.map(x => x.code).join(','));
  await pg.query("DELETE FROM fs_docs WHERE id LIKE 'ztestu%'");
  await pg.close();
  console.log('\nИтог: ' + ok + ' прошло, ' + bad + ' провалено'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('ОШИБКА ТЕСТА', e); process.exit(2); });

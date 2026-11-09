#!/usr/bin/env node
'use strict';
// Тесты слоя совместимости с Firestore (server/pgdocs.js) на настоящем PostgreSQL.
// DATABASE_URL (или локально NODE_PATH=tools/pgshim). Работает в коллекциях с префиксом ztest_ и чистит за собой.
// Таблица fs_docs должна существовать (db/migrations/0004_fs_docs.sql).
const pg = require('../server/pg');
const { firestore, FieldValue: F } = require('../server/pgdocs');
let ok = 0, bad = 0;
const T = (n, c, x) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (x ? ' — ' + x : '')); } };
const db = firestore();
const C = n => db.collection('ztest_' + n);
(async () => {
  await pg.query("DELETE FROM fs_docs WHERE coll LIKE 'ztest\\_%' OR parent LIKE 'ztest\\_%'");
  console.log('\nБазовые операции:');
  const r = C('a').doc('x');
  T('get несуществующего', !(await r.get()).exists);
  await r.set({ n: 1, s: 'привет', o: { a: 1, b: 2 }, arr: [1, 2] });
  let d = (await r.get()).data();
  T('set / get', d.n === 1 && d.s === 'привет' && d.o.b === 2 && d.arr.length === 2);
  await r.set({ o: { a: 9 }, z: 5 }, { merge: true });
  d = (await r.get()).data(); T('set merge вложенных', d.o.a === 9 && d.o.b === 2 && d.z === 5 && d.n === 1);
  await r.update({ 'o.b': F.delete(), n: F.increment(4), 'p.q': 7 });
  d = (await r.get()).data(); T('update: путь, delete, increment', d.o.b === undefined && d.n === 5 && d.p.q === 7);
  let e1; try { await C('a').doc('nope').update({ a: 1 }); } catch (e) { e1 = e; } T('update несуществующего → code 5', e1 && e1.code === 5);
  let e2; try { await r.create({ a: 1 }); } catch (e) { e2 = e; } T('create существующего → code 6', e2 && e2.code === 6);
  await r.delete(); T('delete', !(await r.get()).exists);
  const ar = C('a').doc('arr'); await ar.set({ t: [1] }); await ar.update({ t: F.arrayUnion(1, 2) }); T('arrayUnion', JSON.stringify((await ar.get()).data().t) === '[1,2]');

  console.log('\nЗапросы:');
  for (let i = 1; i <= 8; i++) await C('q').doc('d' + i).set({ i, name: 'n' + (i % 3), tags: i % 2 ? ['odd', 't'] : ['even'], ts: 1000 + i });
  const ids = s => s.docs.map(x => x.id).join(',');
  T('where ==', ids(await C('q').where('name', '==', 'n0').orderBy('i').get()) === 'd3,d6');
  T('where > + limit', ids(await C('q').where('i', '>', 5).limit(2).get()) === 'd6,d7');
  T('where >= <= диапазон', ids(await C('q').where('i', '>=', 3).where('i', '<=', 5).get()) === 'd3,d4,d5');
  T('orderBy desc limit', ids(await C('q').orderBy('ts', 'desc').limit(3).get()) === 'd8,d7,d6');
  T('where in', ids(await C('q').where('name', 'in', ['n1', 'n2']).orderBy('i').get()) === 'd1,d2,d4,d5,d7,d8');
  T('array-contains', ids(await C('q').where('tags', 'array-contains', 'even').orderBy('i').get()) === 'd2,d4,d6,d8');
  T('where != ', (await C('q').where('name', '!=', 'n0').get()).size === 6);
  T('startAfter по документу', ids(await C('q').orderBy('ts').startAfter(await C('q').doc('d3').get()).limit(2).get()) === 'd4,d5');
  T('count()', (await C('q').where('i', '>', 2).count().get()).data().count === 6);
  T('поле отсутствует → не попадает в orderBy', ids(await C('q').orderBy('nofield').get()) === '');
  T('where по строке ">"', (await C('q').where('name', '>', 'n0').get()).size === 6);
  T('сравнение числа не цепляет строки', (await C('q').where('name', '>', 1).get()).size === 0);

  console.log('\nВложенные коллекции и группы:');
  await C('p').doc('u1').collection('log').doc('l1').set({ v: 1 }); await C('p').doc('u2').collection('log').doc('l2').set({ v: 2 });
  T('подколлекция', (await C('p').doc('u1').collection('log').get()).size === 1);
  T('collectionGroup', (await db.collectionGroup('log').where('v', '>', 0).get()).docs.filter(x => x.ref.path.startsWith('ztest_p')).length === 2);
  T('не смешивает родителей', (await C('p').get()).size === 0);

  console.log('\nПакеты и getAll:');
  const b = db.batch(); b.set(C('b').doc('1'), { a: 1 }); b.set(C('b').doc('2'), { a: 2 }); b.update(C('b').doc('1'), { a: F.increment(10) }); await b.commit();
  const all = await db.getAll(C('b').doc('1'), C('b').doc('2'), C('b').doc('3'));
  T('batch + getAll', all[0].data().a === 11 && all[1].data().a === 2 && !all[2].exists);

  console.log('\nТранзакции:');
  const cnt = C('t').doc('cnt'); await cnt.set({ n: 0 });
  await Promise.all(Array.from({ length: 30 }, () => db.runTransaction(async tx => { const s = await tx.get(cnt); tx.update(cnt, { n: s.data().n + 1 }); })));
  T('30 параллельных инкрементов без потерь', (await cnt.get()).data().n === 30, 'n=' + (await cnt.get()).data().n);
  const w1 = C('t').doc('w1'), w2 = C('t').doc('w2'); await w1.set({ g: 100 }); await w2.set({ g: 0 });
  await Promise.all(Array.from({ length: 10 }, (_, i) => db.runTransaction(async tx => {
    const [a, c] = i % 2 ? [w1, w2] : [w2, w1];            // обратный порядок блокировок: проверка повторов при взаимной блокировке
    const sa = await tx.get(a), sc = await tx.get(c);
    if (a === w1 && sa.data().g >= 10) { tx.update(w1, { g: sa.data().g - 10 }); tx.update(w2, { g: sc.data().g + 10 }); }
  })));
  const g1 = (await w1.get()).data().g, g2 = (await w2.get()).data().g; T('перевод между документами: сумма сохраняется', g1 + g2 === 100, g1 + '/' + g2);
  let thrown = false; try { await db.runTransaction(async tx => { tx.set(C('t').doc('rb'), { x: 1 }); throw new Error('boom'); }); } catch (e) { thrown = e.message === 'boom'; }
  T('откат при ошибке', thrown && !(await C('t').doc('rb').get()).exists);
  let ce = 0; await Promise.all(Array.from({ length: 6 }, () => C('t').doc('once').create({ v: 1 }).catch(e => { if (e.code === 6) ce++; })));
  T('create: только один из параллельных побеждает', ce === 5, 'конфликтов ' + ce);
  const q = await db.runTransaction(async tx => (await tx.get(C('q').where('i', '>', 6))).size); T('запрос внутри транзакции', q === 2);

  console.log('\nСлушатели (onSnapshot):');
  process.env.PG_POLL_MS = '300';
  const events = []; const un = C('l').onSnapshot(sn => events.push(sn.docChanges().map(c => c.type + ':' + c.doc.id).join(',')), e => events.push('ERR ' + e.message));
  await new Promise(r => setTimeout(r, 700)); await C('l').doc('a').set({ v: 1 }); await new Promise(r => setTimeout(r, 900));
  await C('l').doc('a').update({ v: 2 }); await new Promise(r => setTimeout(r, 900)); await C('l').doc('a').delete(); await new Promise(r => setTimeout(r, 900)); un();
  T('added/modified/removed', events.join(' | ') === ' | added:a | modified:a | removed:a' || events.filter(Boolean).join('|') === 'added:a|modified:a|removed:a', events.join(' | '));
  const n0 = events.length; await C('l').doc('b').set({}); await new Promise(r => setTimeout(r, 800)); T('после отписки событий нет', events.length === n0);

  T('listCollections видит коллекции', (await db.listCollections()).some(c => c.id === 'ztest_q'));
  await pg.query("DELETE FROM fs_docs WHERE coll LIKE 'ztest\\_%' OR parent LIKE 'ztest\\_%'");
  await pg.close();
  console.log('\nИтог: ' + ok + ' прошло, ' + bad + ' провалено'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('ОШИБКА ТЕСТА', e); process.exit(2); });

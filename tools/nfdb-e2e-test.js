#!/usr/bin/env node
'use strict';
// Сквозной тест без браузера: клиентская прослойка (public/js/nfdb.js) ↔ шлюз (server/fsgate.js) ↔ pgdocs ↔ PostgreSQL.
// Сеть подменена: fetch вызывает шлюз напрямую, «сокет» передаёт сообщения туда и обратно.
process.env.STORE = 'pg'; process.env.PG_POLL_MS = '2000';
const vm = require('vm'), fs = require('fs'), path = require('path');
const pg = require('../server/pg'), docs = require('../server/pgdocs');
let ok = 0, bad = 0;
const T = (n, c, x) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (x ? ' — ' + x : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const G = require('../server/fsgate')(() => docs.firestore(), async tok => { if (!tok.startsWith('t:')) throw new Error('bad'); return tok.slice(2); });

function browser(user) {                      // отдельный «браузер» с своей прослойкой и сокетом
  const win = { console, setTimeout, clearTimeout };
  const toClient = [];
  const conn = { uid: '', open: true };
  win.fetch = (url, o) => new Promise(res => {
    const out = { writeHead(c) { this.c = c; }, end(b) { res({ json: async () => JSON.parse(b) }); } };
    G.http({ headers: { authorization: (o.headers || {}).Authorization || '', 'x-forwarded-for': 'e2e' }, socket: {} }, out, Buffer.from(o.body));
  });
  vm.createContext(win); win.window = win;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/nfdb.js'), 'utf8'), win);
  const N = win.NFDB, db = N.create(() => Promise.resolve(user ? 't:' + user : ''));
  const send = m => { if (m.t === 'hello') { conn.uid = user || ''; G.drop(conn); } else G.onMsg(conn, m, (c, x) => setImmediate(() => N.onMsg(x))); };
  return { db, N, connect() { N.attach(send); N.wsOpen(); send({ t: 'hello' }); N.onHello(); }, close() { G.drop(conn); N.onClose(); }, conn };
}
(async () => {
  const wipe = () => pg.query("DELETE FROM fs_docs WHERE id LIKE 'e2e\\_%' OR parent LIKE 'dm/tzalice~tzbob%' OR path IN ('players/tzalice','names/e2e_nick') OR (parent = 'chat' AND data->>'uid' = 'tzalice')");
  await wipe();
  const A = browser('tzalice'), B = browser('tzbob'), ANON = browser('');
  console.log('\nКлиентская прослойка + шлюз + Postgres');
  // разовые операции
  T('names читается без входа', (await ANON.db.collection('names').doc('e2e_nick').get()).exists === false);
  await A.db.collection('names').doc('e2e_nick').set({ uid: 'tzalice', name: 'Alice' });
  const sn = await ANON.db.collection('names').doc('e2e_nick').get();
  T('set/get: exists-свойство и data()', sn.exists === true && sn.data().uid === 'tzalice' && sn.id === 'e2e_nick');
  let err; try { await B.db.collection('names').doc('e2e_nick').set({ uid: 'tzbob' }); } catch (e) { err = e; }
  T('отказ приходит как ошибка с code permission-denied', err && err.code === 'permission-denied');
  const ref = await A.db.collection('chat').add({ uid: 'tzalice', text: 'привет', ts: 9e15 + 1 });
  T('add возвращает ссылку с id', ref && ref.id && ref.id.length === 20 && (await A.db.collection('chat').doc(ref.id).get()).data().text === 'привет');
  await A.db.collection('chat').add({ uid: 'tzalice', text: 'второе', ts: 9e15 + 2 });
  const q = await B.db.collection('chat').orderBy('ts', 'desc').limit(1).get();
  T('запрос: orderBy desc + limit', q.size === 1 && q.docs[0].data().text === 'второе' && !q.empty);
  const q2 = await B.db.collection('chat').where('ts', '>', 9e15 + 1).get();
  T('запрос: where >', q2.size === 1);
  let n = 0; q2.forEach(() => n++); T('forEach / docs.map', n === 1 && q2.docs.map(d => d.data().text)[0] === 'второе');
  await A.db.collection('forum').doc('e2e_t').set({ title: 'x', c: { a: 1 } });
  await A.db.collection('forum').doc('e2e_t').update({ 'c.b': 2 });
  await A.db.collection('forum').doc('e2e_t').collection('posts').add({ text: 'p1', ts: 5 });
  await A.db.collection('forum').doc('e2e_t').collection('posts').add({ text: 'p2', ts: 6 });
  const posts = await A.db.collection('forum').doc('e2e_t').collection('posts').where('ts', '>', 0).orderBy('ts', 'desc').limit(1).get();
  const next = await A.db.collection('forum').doc('e2e_t').collection('posts').where('ts', '>', 0).orderBy('ts', 'desc').startAfter(posts.docs[0]).limit(5).get();
  T('update по пути + подколлекции + startAfter', (await A.db.collection('forum').doc('e2e_t').get()).data().c.b === 2 && posts.docs[0].data().text === 'p2' && next.size === 1 && next.docs[0].data().text === 'p1');
  T('ref.parent и ref.path', posts.docs[0].ref.parent.id === 'posts' && posts.docs[0].ref.path.startsWith('forum/e2e_t/posts/'));
  await A.db.collection('forum').doc('e2e_t').delete().then(() => null, e => e);
  // подписки через сокет
  console.log('\nПодписки');
  A.connect(); B.connect(); ANON.connect();
  const evA = [], evB = []; let docEv = [];
  const unA = A.db.collection('chat').orderBy('ts', 'desc').limit(60).onSnapshot(s => evA.push(s.docs.slice(0, 3).map(d => d.data().text).join('|')), e => evA.push('ERR'));
  const unB = B.db.collection('chat').orderBy('ts', 'desc').limit(60).onSnapshot(s => evB.push({ top: s.docs[0].data().text, ch: s.docChanges().map(c => c.type) }));
  const unD = A.db.collection('names').doc('e2e_nick').onSnapshot(d => docEv.push(d.exists ? d.data().name : 'none'));
  let anonErr = null; ANON.db.collection('chat').limit(5).onSnapshot(() => { }, e => { anonErr = e; });
  await sleep(1500);
  T('первый снимок приходит (сортировка соблюдена)', evA.length >= 1 && evA[0] === 'второе|привет' || evA[0].startsWith('второе|привет'), JSON.stringify(evA));
  T('документ-подписка: exists/data', docEv[0] === 'Alice');
  T('аноним на чат: permission-denied', anonErr && anonErr.code === 'permission-denied');
  const k = evB.length;
  await A.db.collection('chat').add({ uid: 'tzalice', text: 'новое', ts: 9e15 + 3 });
  await sleep(900);
  T('новая запись доходит до другого клиента почти сразу', evB.length > k && evB[evB.length - 1].top === 'новое' && evB[evB.length - 1].ch.includes('added'), JSON.stringify(evB.slice(-2)));
  T('и до автора', evA[evA.length - 1].startsWith('новое|'));
  await A.db.collection('names').doc('e2e_nick').update({ name: 'Alice2' }); await sleep(700);
  T('изменение документа приходит в подписку', docEv[docEv.length - 1] === 'Alice2');
  unA(); const nA = evA.length; await A.db.collection('chat').add({ uid: 'tzalice', text: 'после отписки', ts: 9e15 + 4 }); await sleep(700);
  T('после отписки событий нет', evA.length === nA);
  // обрыв сокета → опрос по HTTP, затем возврат
  console.log('\nОбрыв и восстановление сокета');
  const evC = []; const unC = B.db.collection('chat').orderBy('ts', 'desc').limit(60).onSnapshot(s => evC.push(s.docs[0].data().text));
  await sleep(700); B.close(); await A.db.collection('chat').add({ uid: 'tzalice', text: 'пока сокет мёртв', ts: 9e15 + 5 }); await sleep(100);
  const before = evC.length; await sleep(4800);
  T('при обрыве подписка живёт на HTTP-опросе', evC.length > before, 'событий ' + (evC.length - before));
  B.connect(); await sleep(900);
  await A.db.collection('chat').add({ uid: 'tzalice', text: 'сокет вернулся', ts: 9e15 + 6 }); await sleep(900);
  T('после возврата снова приходит по сокету', evC[evC.length - 1] === 'сокет вернулся', JSON.stringify(evC.slice(-3)));
  unB(); unC(); unD();
  A.close(); B.close(); ANON.close();
  await wipe(); await pg.query("DELETE FROM fs_docs WHERE parent = 'chat' AND data->>'uid' = 'tzalice'");
  await pg.close();
  console.log('\nИтог: ' + ok + ' прошло, ' + bad + ' провалено'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('ОШИБКА ТЕСТА', e); process.exit(2); });

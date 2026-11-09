#!/usr/bin/env node
'use strict';
// Запускает НАСТОЯЩИЙ server/index.js с STORE=pg (нужны firebase-admin, FIREBASE_SERVICE_ACCOUNT, DATABASE_URL на тестовую базу)
// и проверяет по HTTP и WebSocket: /store.js, шлюз для не вошедшего, подписка на names, запрет остального.
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8791;
let ok = 0, bad = 0;
const T = (n, c, x) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (x ? ' — ' + x : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (p, b, h) => fetch('http://127.0.0.1:' + PORT + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}), body: JSON.stringify(b) }).then(async r => ({ code: r.status, body: await r.json().catch(() => null) }));
(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '../server/index.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), STORE: 'pg', CRON: 'off', PG_POOL_MAX: '4', PG_CONN_TIMEOUT_MS: '60000', PG_POLL_MS: '500' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 60; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/healthz'); if (r.ok) break; } catch (e) {} await sleep(500); }
  console.log('\nЗапуск настоящего сервера со STORE=pg');
  try {
    const st = await (await fetch('http://127.0.0.1:' + PORT + '/store.js')).text();
    T('/store.js отдаёт pg', st.includes('"pg"'), st);
    let r = await post('/api/fs', { op: 'get', path: 'names/boot_test_nick' });
    T('шлюз: аноним читает names', r.code === 200 && r.body.ok === true, JSON.stringify(r));
    r = await post('/api/fs', { op: 'get', path: 'players/x' });
    T('шлюз: аноним не читает players', r.code === 403);
    r = await post('/api/fs', { op: 'set', path: 'names/boot_test_nick', data: { uid: 'x' } });
    T('шлюз: аноним не пишет', r.code === 403);
    r = await post('/api/fs', { op: 'get', path: 'names/x' }, { Authorization: 'Bearer not-a-real-token' });
    T('шлюз: мусорный токен → 401', r.code === 401, JSON.stringify(r));
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws'); const got = [];
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(() => rej(new Error('ws timeout')), 8000); });
    ws.onmessage = e => got.push(JSON.parse(e.data));
    ws.send(JSON.stringify({ t: 'hello', g: 'boottest', v: 2 }));
    ws.send(JSON.stringify({ t: 'fsl', id: 'a1', q: { d: 'names/boot_test_nick' } }));
    ws.send(JSON.stringify({ t: 'fsl', id: 'a2', q: { p: 'chat', l: 5 } }));
    await sleep(3000);
    const a1 = got.find(m => m.id === 'a1'), a2 = got.find(m => m.id === 'a2');
    T('сокет: гость подписывается на names', a1 && a1.t === 'fss' && a1.full === true, JSON.stringify(a1));
    T('сокет: гостю чат закрыт', a2 && a2.t === 'fse' && a2.code === 7, JSON.stringify(a2));
    T('сокет: хаб по-прежнему отвечает', got.some(m => m.t === 'me'));
    ws.send(JSON.stringify({ t: 'sub', c: ['players'] })); await sleep(2500);
    T('старые ленты хаба (players) работают на pg', got.some(m => m.t === 'snap' && m.c === 'players'));
    const hz = await (await fetch('http://127.0.0.1:' + PORT + '/hubz')).json();
    T('/hubz отвечает', !!hz && typeof hz === 'object');
    ws.close();
  } catch (e) { T('сервер отвечает', false, String(e && e.message)); }
  child.kill('SIGTERM'); await sleep(500);
  const errs = log.split('\n').filter(l => /Error|ReferenceError|TypeError|unhandled/i.test(l) && !/firebase init|Quota/i.test(l));
  T('в логе сервера нет ошибок', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\nИтог: ' + ok + ' прошло, ' + bad + ' провалено'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('ОШИБКА ТЕСТА', e); process.exit(2); });

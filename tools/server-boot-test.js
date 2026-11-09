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

// минимальный WebSocket-клиент (Node 20 не имеет глобального WebSocket)
function wsClient(port) {
  const http = require('http'), crypto = require('crypto');
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host: '127.0.0.1', port, path: '/ws', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
    req.on('upgrade', (res, sock) => {
      const got = []; let buf = Buffer.alloc(0);
      sock.on('data', d => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) return; let len = buf[1] & 127, o = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); o = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); o = 10; }
          if (buf.length < o + len) return;
          const op = buf[0] & 15, p = buf.slice(o, o + len); buf = buf.slice(o + len);
          if (op === 1) { try { got.push(JSON.parse(p.toString('utf8'))); } catch (e) {} }
        }
      });
      const send = obj => {
        const p = Buffer.from(JSON.stringify(obj)), m = crypto.randomBytes(4); let h;
        if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]); else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
        const body = Buffer.from(p.map((b, i) => b ^ m[i % 4]));
        sock.write(Buffer.concat([h, m, body]));
      };
      resolve({ got, send, close: () => sock.destroy() });
    });
    req.on('error', reject); req.end();
  });
}
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
    const ws = await wsClient(PORT), got = ws.got;
    ws.send({ t: 'hello', g: 'boottest', v: 2 });
    ws.send({ t: 'fsl', id: 'a1', q: { d: 'names/boot_test_nick' } });
    ws.send({ t: 'fsl', id: 'a2', q: { p: 'chat', l: 5 } });
    await sleep(3000);
    const a1 = got.find(m => m.id === 'a1'), a2 = got.find(m => m.id === 'a2');
    T('сокет: гость подписывается на names', a1 && a1.t === 'fss' && a1.full === true, JSON.stringify(a1));
    T('сокет: гостю чат закрыт', a2 && a2.t === 'fse' && a2.code === 7, JSON.stringify(a2));
    T('сокет: хаб по-прежнему отвечает', got.some(m => m.t === 'me'));
    ws.send({ t: 'sub', c: ['players'] }); await sleep(2500);
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

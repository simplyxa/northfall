// Замер трафика сокет-хаба: сколько байт уходит на клиента при одном изменении.
// Запуск: node tools/wsbench.js [игроков]
// Сравнивает старый протокол (полный снимок) и новый (дельта).
'use strict';
const http = require('http');
const hub = require('../server/hub');

const N = +process.argv[2] || 300;

// --- мок базы: N игроков в коллекции players ---
const docs = new Map();
for (let i = 0; i < N; i++) {
  docs.set('p' + String(i).padStart(4, '0'), {
    n: 'Игрок' + i, lv: 1 + (i % 40), hp: 100, max: 100, atk: 12 + (i % 30),
    def: 5 + (i % 20), gold: 1000 * (i % 17), iron: 30 * (i % 9), cls: 'berserk',
    guild: 'clan' + (i % 12), lastSeen: Date.now(), ts: Date.now()
  });
}
let emit = null;
const db = {
  collection() {
    const q = {
      limit: () => q, orderBy: () => q,
      onSnapshot(cb) {
        emit = cb;
        setImmediate(() => cb({
          docs: [...docs.entries()].map(([id, d]) => ({ id, data: () => d })),
          docChanges: () => [...docs.entries()].map(([id, d]) => ({ type: 'added', doc: { id, data: () => d } }))
        }));
        return () => { };
      }
    };
    return q;
  }
};

function connect(port, proto) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    const c = { bytes: 0, count: 0, ready: false };
    ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', g: 'bench0001', v: proto })); ws.send(JSON.stringify({ t: 'sub', c: ['players'] })); resolve(c); };
    ws.onerror = () => reject(new Error('ws error'));
    ws.onmessage = e => { c.bytes += e.data.length; c.count++; };
    c.close = () => ws.close();
  });
}

(async function () {
  const server = http.createServer((q, s) => { s.writeHead(200); s.end('ok'); });
  hub(server, () => db, async () => 'bench');
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const v1 = await connect(port, 0);   // старый клиент: полный снимок
  const v2 = await connect(port, 2);   // новый клиент: дельта
  await new Promise(r => setTimeout(r, 400));

  const b1 = v1.bytes, b2 = v2.bytes, c1 = v1.count, c2 = v2.count;

  // одно изменение — меняем одного игрока
  const id = 'p0007';
  docs.set(id, { ...docs.get(id), lv: 99, hp: 42 });
  const feed = { docs: [...docs.entries()].map(([i, d]) => ({ id: i, data: () => d })), docChanges: () => [{ type: 'modified', doc: { id, data: () => docs.get(id) } }] };
  if (emit) emit(feed);

  await new Promise(r => setTimeout(r, 400));
  const d1 = v1.bytes - b1, d2 = v2.bytes - b2;

  console.log('\nТрафик на ОДНО изменение в ленте из ' + N + ' игроков\n');
  console.log('  v1 (полный снимок): ' + fmt(d1) + '   сообщений: ' + (v1.count - c1));
  console.log('  v2 (дельта):        ' + fmt(d2) + '   сообщений: ' + (v2.count - c2));
  if (d1 > 0) console.log('  экономия:           ' + (d1 / Math.max(1, d2)).toFixed(1) + '×');
  console.log('\n  на 50 игроков в эфире при 4 изменениях в секунду:');
  const perSec = 4;
  console.log('    v1: ' + fmt(d1 * perSec * 50) + '/сек   v2: ' + fmt(d2 * perSec * 50) + '/сек');
  console.log('');

  v1.close(); v2.close();
  await new Promise(r => setTimeout(r, 100));
  server.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

function fmt(b) { return b < 1024 ? b + ' Б' : b < 1048576 ? (b / 1024).toFixed(1) + ' КБ' : (b / 1048576).toFixed(2) + ' МБ'; }

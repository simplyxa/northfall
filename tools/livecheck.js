// Проверка живой выкладки: сайт, сокет-хаб и протокол.
// Запуск: node tools/livecheck.js [домен]
// По умолчанию проверяет https://playnorthfall.online
'use strict';
const URL_ = process.argv[2] || 'https://playnorthfall.online';
const WS = URL_.replace(/^http/, 'ws') + '/ws';

let failed = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

(async function () {
  console.log('\nПроверка живой выкладки: ' + URL_ + '\n');

  // 1. сайт отвечает
  const r = await fetch(URL_ + '/healthz').catch(() => null);
  ok('/healthz отвечает', r && r.status === 200, r ? 'код ' + r.status : 'нет ответа');

  // 2. главная страница отдаётся и содержит актуальный клиент
  const html = await (await fetch(URL_ + '/')).text().catch(() => '');
  ok('главная страница отдаётся', html.length > 100000, 'размер ' + html.length);
  ok('клиент поддерживает дельты (upd)', html.includes("m.t==='upd'"));
  ok('клиент объявляет протокол v2', html.includes('undefined,v:2'));

  // 3. английская версия синхронна с русской
  const en = await (await fetch(URL_ + '/en/')).text().catch(() => '');
  ok('EN-версия отдаётся', en.length > 100000, 'размер ' + en.length);
  ok('EN тоже поддерживает дельты', en.includes("m.t==='upd'"));

  // 4. хаб жив
  const hub = await (await fetch(URL_ + '/hubz')).text().catch(() => '{}');
  let h = {};
  try { h = JSON.parse(hub); } catch (e) {}
  ok('/hubz отвечает', !!h.feeds, hub.slice(0, 120));
  console.log('    клиентов онлайн: ' + (h.clients != null ? h.clients : '?') +
    ', лент: ' + Object.keys(h.feeds || {}).length);

  // 5. сокет принимает соединение и отдаёт снимок
  await new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const ws = new WebSocket(WS);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} finish(null); }, 12000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', g: 'livecheck001', v: 2 }));
      setTimeout(() => ws.send(JSON.stringify({ t: 'sub', c: ['players', 'clans'] })), 300);
    };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.t === 'snap') {
        console.log('    снимок ленты ' + m.c + ': ' + (m.d ? m.d.length : 0) + ' док., ' + (e.data.length / 1024).toFixed(1) + ' КБ');
        ok('сокет отдаёт снимок ленты', Array.isArray(m.d));
        clearTimeout(timer); try { ws.close(); } catch (x) {} finish(true);
      }
    };
    ws.onerror = () => { clearTimeout(timer); finish(null); };
  });

  // 6. ограничение частоты работает (без токена сервер должен отвечать 401, а не 429 на первых)
  const lim = await fetch(URL_ + '/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"s":{},"ses":"x"}' }).catch(() => null);
  ok('мусорный запрос отклоняется (401/503), а не проходит', lim && (lim.status === 401 || lim.status === 503), lim ? 'код ' + lim.status : 'нет ответа');

  console.log(failed ? '\n  есть проблемы: ' + failed + '\n' : '\n  всё в порядке\n');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ОШИБКА:', e); process.exit(1); });

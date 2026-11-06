// Сводка воронки за N дней: только суммы счётчиков, без личных данных.
const admin = require('../netlify/lib/fb');
const db = admin.firestore();
const day = t => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
(async () => {
  const N = +process.env.DAYS || 21, EV = ['visit', 'scr', 'tap', 'guest', 'h1', 'k2', 'nbc', 'l3', 'reg', 'lvl5'];
  const tot = {}, per = {}, byDay = {};
  for (let i = 0; i < N; i++) {
    const k = day(Date.now() - i * 864e5), sn = await db.collection('stats').doc(k).get(); if (!sn.exists) continue;
    for (const [f, v] of Object.entries(sn.data())) { if (/^h\d\d__/.test(f)) continue; const [s, e] = f.split('__'); if (!e) continue;
      tot[e] = (tot[e] || 0) + v; per[s] = per[s] || {}; per[s][e] = (per[s][e] || 0) + v; byDay[k] = byDay[k] || {}; byDay[k][e] = (byDay[k][e] || 0) + v; }
  }
  const row = o => EV.map(e => String(o[e] || 0).padStart(6)).join('');
  console.log('          ' + EV.map(e => e.padStart(6)).join(''));
  console.log('TOTAL     ' + row(tot));
  for (const [s, o] of Object.entries(per).sort((a, b) => (b[1].visit || 0) - (a[1].visit || 0))) console.log(s.slice(0, 9).padEnd(10) + row(o));
  for (const k of Object.keys(byDay).sort()) console.log(k.slice(5).padEnd(10) + row(byDay[k]));
  // распределение уровней зарегистрированных героев (только количества)
  const ps = await db.collection('players').select('lvl', 'seen', 'ts').get(), L = {}; let act7 = 0;
  ps.forEach(d => { const x = d.data(), l = x.lvl | 0, b = l < 3 ? '1-2' : l < 5 ? '3-4' : l < 10 ? '5-9' : l < 20 ? '10-19' : l < 40 ? '20-39' : '40+'; L[b] = (L[b] || 0) + 1; if (Date.now() - (x.seen || 0) < 7 * 864e5) act7++; });
  console.log('players', ps.size, 'active7d', act7, JSON.stringify(L));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });

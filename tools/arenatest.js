// Тесты серверной логики арены: рейтинг, сезон, билеты, уровень.
// Запуск: node tools/arenatest.js
// Чистые функции, внешних сервисов не нужно.
'use strict';
const A = require('../server/arena');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
const HOUR = 3600000, WEEK = 604800000;
const NOW = 1700000000000;

console.log('\nNorthfall — тесты серверной логики арены\n');

// ---------- начальное состояние ----------
{
  const st = A.readState(null, NOW);
  ok('новый игрок: рейтинг 1000', st.rt === 1000, 'rt=' + st.rt);
  ok('новый игрок: 10 билетов арены', st.atk === 10, 'atk=' + st.atk);
  ok('новый игрок: сезон = текущая неделя', st.sid === Math.floor(NOW / WEEK), 'sid=' + st.sid);
  ok('новый игрок: сезонные очки 0', st.srt === 0);
}

// ---------- билеты начисляются по часам ----------
{
  const prev = { atk: 2, atkt: NOW - 3 * HOUR, rating: 1000, srat: 0, sid: Math.floor(NOW / WEEK) };
  const st = A.readState(prev, NOW);
  ok('за 3 часа начислилось 3 билета', st.atk === 5, 'atk=' + st.atk);
}
{
  const prev = { atk: 2, atkt: NOW - 10 * HOUR, rating: 1000, srat: 0, sid: Math.floor(NOW / WEEK) };
  const st = A.readState(prev, NOW);
  ok('билеты не копятся выше 10', st.atk === 10, 'atk=' + st.atk);
}
{
  const prev = { atk: 10, atkt: NOW - 5 * HOUR, rating: 1000, srat: 0, sid: Math.floor(NOW / WEEK) };
  const st = A.readState(prev, NOW);
  ok('при полном запасе время не копится', st.atk === 10);
}

// ---------- новый сезон ----------
{
  const old = Math.floor(NOW / WEEK) - 1;
  const prev = { atk: 5, atkt: NOW, rating: 1500, srat: 320, sid: old, psid: 0, psrat: 0 };
  const st = A.readState(prev, NOW);
  ok('новый сезон: сезонные очки обнулены', st.srt === 0, 'srt=' + st.srt);
  ok('новый сезон: прошлый сезон запомнен', st.psid === old && st.psrat === 320, `psid=${st.psid} psrat=${st.psrat}`);
  ok('новый сезон: общий рейтинг не тронут', st.rt === 1500);
}

// ---------- применение результата ----------
{
  const st = { rt: 1000, srt: 0, sid: 1, psid: 0, psrat: 0, atk: 10, atkt: NOW };
  const r = A.applyResult(st, { d: 22 });
  ok('победа: рейтинг +22', r.rt === 1022, 'rt=' + r.rt);
  ok('победа: сезонные очки +22', r.srt === 22);
  ok('победа: списан один билет', r.atk === 9 && r.used === 1);
}
{
  const st = { rt: 1000, srt: 0, sid: 1, psid: 0, psrat: 0, atk: 10, atkt: NOW };
  const r = A.applyResult(st, { d: -12 });
  ok('поражение: рейтинг −12', r.rt === 988, 'rt=' + r.rt);
  ok('поражение: сезонные очки не ушли в минус', r.srt === 0);
}
{
  const st = { rt: 1000, srt: 0, sid: 1, psid: 0, psrat: 0, atk: 10, atkt: NOW };
  const r = A.applyResult(st, { d: 99999 });
  ok('победа: прибавка ограничена сверху (46)', r.rt === 1046, 'rt=' + r.rt);
}
{
  const st = { rt: 1000, srt: 0, sid: 1, psid: 0, psrat: 0, atk: 10, atkt: NOW };
  const r = A.applyResult(st, { d: -99999 });
  ok('поражение: списание ограничено снизу (−25)', r.rt === 975, 'rt=' + r.rt);
}
{
  const st = { rt: 1000, srt: 0, sid: 1, psid: 0, psrat: 0, atk: 10, atkt: NOW };
  const r = A.applyResult(st, { d: 3 });
  ok('победа: слишком маленькая прибавка поднята до 8', r.rt === 1008, 'rt=' + r.rt);
}
{
  const st = { rt: 1000, srt: 0, sid: 1, psid: 0, psrat: 0, atk: 0, atkt: NOW };
  const r = A.applyResult(st, { d: 22 });
  ok('без билета результат не засчитан', r.rt === 1000 && r.used === 0 && r.rej === 1, JSON.stringify(r));
}
{
  const st = { rt: 1000, srt: 0, sid: 1, psid: 0, psrat: 0, atk: 10, atkt: NOW };
  ok('без заявки ничего не меняется', A.applyResult(st, null).rt === 1000);
  ok('заявка без числа игнорируется', A.applyResult(st, { d: 'x' }).rt === 1000);
  ok('NaN игнорируется', A.applyResult(st, { d: NaN }).rt === 1000);
}
{
  // читер: рейтинг подскотал, но заявки нет — сервер игнорирует
  const st = { rt: 1000, srt: 0, sid: 1, psid: 0, psrat: 0, atk: 10, atkt: NOW };
  const r = A.applyResult(st, null);
  ok('рейтинг без заявки не меняется (читер)', r.rt === 1000 && r.atk === 10);
}

// ---------- билеты кончились: рейтинг больше не растёт ----------
{
  let st = { rt: 1000, srt: 0, sid: 1, psid: 0, psrat: 0, atk: 2, atkt: NOW };
  st = A.applyResult(st, { d: 40 }); st.atk = 1;
  st = A.applyResult(st, { d: 40 }); st.atk = 0;
  const r = A.applyResult(st, { d: 40 });
  ok('после 10 билетов рейтинг не растёт', r.rt === st.rt && r.rej === 1, 'rt=' + r.rt);
}

// ---------- счётчики побед ----------
{
  const prev = { win: 10, lose: 2 };
  const w = A.clampWins(prev, NOW, 5000);
  ok('за 5 секунд можно закрыть до 6 убийств', w.max === 6, 'max=' + w.max);
  ok('счётчики не уменьшаются', w.win === 10 && w.lose === 2);
}
{
  const w = A.clampWins({ win: 10, lose: 2 }, NOW, 60000);
  ok('за минуту потолок выше', w.max > 6, 'max=' + w.max);
}

// ---------- уровень ----------
{
  ok('уровень не выше 60', A.clampLevel({ lvl: 55 }, 90) === 60);
  ok('уровень не выше +10 за запись', A.clampLevel({ lvl: 5 }, 40) === 15, 'lvl=' + A.clampLevel({ lvl: 5 }, 40));
  ok('уровень не уменьшается', A.clampLevel({ lvl: 20 }, 3) === 20);
  ok('новый игрок: уровень до 60 (как в старых правилах)', A.clampLevel(null, 10) === 10 && A.clampLevel(null, 90) === 60);
}

console.log('\n  пройдено: ' + passed + ', провалено: ' + failed + '\n');
process.exit(failed ? 1 : 0);

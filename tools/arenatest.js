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

// ---------- дневной рейтинг лайв-арены ----------
{
  const now = 1700000000000;
  const st = A.readState({ rating: 1200, srat: 40, sid: A.season(now), atk: 5, atkt: now, dr: 1400, dn: 3, dw: 2, day: A.dayNum(now) }, now);
  ok('дневной рейтинг читается из сохранения', st.dr === 1400 && st.dn === 3 && st.dw === 2, `dr=${st.dr} dn=${st.dn} dw=${st.dw}`);
}
{
  // новые сутки — дневной рейтинг обнуляется
  const now = 1700000000000;
  const y = now - 90000000; // вчера
  const st = A.readState({ rating: 1200, sid: A.season(now), dr: 1500, dn: 7, dw: 4, day: A.dayNum(y) }, now);
  ok('новые сутки: дневной рейтинг сброшен на 1000', st.dr === 1000, 'dr=' + st.dr);
  ok('новые сутки: счётчики боёв обнулены', st.dn === 0 && st.dw === 0, `dn=${st.dn} dw=${st.dw}`);
  ok('новые сутки: общий рейтинг не тронут', st.rt === 1200, 'rt=' + st.rt);
}
{
  const now = 1700000000000;
  const st = A.readState({ sid: A.season(now), day: A.dayNum(now) }, now);
  const r = A.applyDuel(st, 1, 1000);
  ok('победа: дневный рейтинг вырос', r.dr > 1000, 'dr=' + r.dr);
  ok('победа: счётчик боёв +1', r.dn === 1);
  ok('победа: счётчик побед +1', r.dw === 1);
  ok('победа: дельта положительна', r.dR > 0, 'dR=' + r.dR);
}
{
  const now = 1700000000000;
  const st = A.readState({ sid: A.season(now), day: A.dayNum(now), dr: 1000 }, now);
  const r = A.applyDuel(st, 0, 1000);
  ok('поражение: дневный рейтинг упал', r.dr < 1000, 'dr=' + r.dr);
  ok('поражение: побед не засчитано', r.dw === 0);
  ok('поражение: боёв +1', r.dn === 1);
}
{
  const now = 1700000000000;
  const st = A.readState({ sid: A.season(now), day: A.dayNum(now), dr: 1000 }, now);
  const r = A.applyDuel(st, 0.5, 1000);
  ok('ничья: рейтинг не меняется при равных соперниках', r.dr === 1000, 'dr=' + r.dr);
}
{
  const now = 1700000000000;
  const st = A.readState({ sid: A.season(now), day: A.dayNum(now), dr: 1000 }, now);
  const r = A.applyDuel(st, 0, 500);
  ok('слабый соперник: поражение больнее', r.dR < -20, 'dR=' + r.dR);
  const st2 = A.readState({ sid: A.season(now), day: A.dayNum(now), dr: 1000 }, now);
  const r2 = A.applyDuel(st2, 0, 3000);
  ok('сильный соперник: поражение почти ничего не стоит (Эло)', r2.dR === 0, 'dR=' + r2.dR);
}
{
  const now = 1700000000000;
  const st = A.readState({ sid: A.season(now), day: A.dayNum(now), dr: 5 }, now);
  const r = A.applyDuel(st, 0, 2000);
  ok('дневной рейтинг не уходит в минус', r.dr >= 0, 'dr=' + r.dr);
}
{
  ok('золото за победу: 50 + 15 за уровень', A.duelGold(1) === 65 && A.duelGold(30) === 500, `lvl1=${A.duelGold(1)} lvl30=${A.duelGold(30)}`);
}
{
  // сутки считаются по Израилю (+2 часа), как в клиенте
  ok('сутки по Израилю (+2ч)', A.dayNum(1700000000000) === Math.floor((1700000000000 + 2*3600000)/86400000));
}

// ---------- подсчёт дуэли целиком ----------
{
  const now = 1700000000000;
  const members = { u1: { lv: 30 }, u2: { lv: 10 } };
  const prevs = {
    u1: { rating: 1000, srat: 0, sid: A.season(now), atk: 10, atkt: now, dr: 1000, dn: 0, dw: 0, day: A.dayNum(now) },
    u2: { rating: 1000, srat: 0, sid: A.season(now), atk: 10, atkt: now, dr: 1000, dn: 0, dw: 0, day: A.dayNum(now) }
  };
  const res = A.scoreDuel(members, 'u1', prevs, now);
  ok('дуэль: победителю очки 1', res && res.u1.sc === 1);
  ok('дуэль: проигравшему очки 0', res && res.u2.sc === 0);
  ok('дуэль: победитель получает золото', res && res.u1.g === 500, 'g=' + (res && res.u1.g));
  ok('дуэль: проигравший золота не получает', res && res.u2.g === 0);
  ok('дуэль: дневной рейтинг победителя вырос', res && res.u1.dr > 1000, 'dr=' + (res && res.u1.dr));
  ok('дуэль: дневной рейтинг проигравшего упал', res && res.u2.dr < 1000, 'dr=' + (res && res.u2.dr));
  ok('дуэль: счётчик боёв у обоих +1', res && res.u1.dn === 1 && res.u2.dn === 1);
  ok('дуэль: победы засчитаны только победителю', res && res.u1.dw === 1 && res.u2.dw === 0);
  const draw = A.scoreDuel(members, 'draw', prevs, now);
  ok('дуэль-ничья: у обоих по 0.5', draw && draw.u1.sc === 0.5 && draw.u2.sc === 0.5);
  ok('дуэль-ничья: золота никому', draw && draw.u1.g === 0 && draw.u2.g === 0);
  ok('дуэль: не трое участников — результата нет', A.scoreDuel({ a: {}, b: {}, c: {} }, 'a', prevs, now) === null);
  ok('дуэль: без победителя — результата нет', A.scoreDuel(members, null, prevs, now) === null);
}

console.log('\n  пройдено: ' + passed + ', провалено: ' + failed + '\n');
process.exit(failed ? 1 : 0);

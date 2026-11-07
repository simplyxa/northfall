// Тесты игровой логики и ограничения частоты. Запуск: node tools/gametest.js
// Внешних сервисов не нужно: считаем раунд дуэли и лимитер в памяти.
'use strict';
const assert = require('assert');
const dRound = require('../server/duel').dRound;
const { makeLimiter } = require('../server/ratelimit');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

// детерминированный случайный: rnd(.85,1.15) даёт ровно 1.0, крит выключен
const realRandom = Math.random;
Math.random = () => 0.5;

function hero(n, o, over) {
  return Object.assign({ n, o, atk: 50, def: 0, hp: 500, max: 500, crit: 0, cls: 'berserk', pot: 0, stun: 0, pcd: 0, scd: 0, miss: 0 }, over || {});
}
function duel(a, b, r) {
  return { mem: { A: a, B: b }, r: r || 1, dl: 0, st: 'on', log: [] };
}

console.log('\nNorthfall — тесты игровой логики\n');

// ---------- раунд дуэли ----------
{
  const R = duel(hero('A', 0), hero('B', 1));
  dRound(R, { A: 'atk', B: 'atk' });
  ok('обычный удар: оба получают урон', R.mem.A.hp === 450 && R.mem.B.hp === 450, `A=${R.mem.A.hp} B=${R.mem.B.hp}`);
  ok('обычный удар: раунд идёт дальше', R.r === 2 && R.st === 'on' && !R.win);
}
{
  // пропуск хода: кто не выбрал действие — промах
  const R = duel(hero('A', 0), hero('B', 1));
  dRound(R, { A: 'atk' });
  ok('пропущенный ход считается промахом', R.mem.B.miss === 1 && R.mem.A.miss === 0, `A=${R.mem.A.miss} B=${R.mem.B.miss}`);
}
{
  // три промаха подряд = поражение
  const R = duel(hero('A', 0), hero('B', 1));
  dRound(R, { A: 'atk' }); dRound(R, { A: 'atk' }); dRound(R, { A: 'atk' });
  ok('три промаха = поражение', R.st === 'end' && R.win === 'A', `st=${R.st} win=${R.win}`);
}
{
  // оглушение: оглушённый не атакует
  const R = duel(hero('A', 0, { stun: 5 }), hero('B', 1));
  dRound(R, { A: 'atk', B: 'atk' });
  ok('оглушённый не наносит урон', R.mem.B.hp === 500 && R.mem.A.hp === 450, `A=${R.mem.A.hp} B=${R.mem.B.hp}`);
}
{
  // щит: входящий урон вдвое меньше
  const plain = duel(hero('A', 0), hero('B', 1));
  dRound(plain, { A: 'atk', B: 'atk' });
  const shielded = duel(hero('A', 0), hero('B', 1));
  dRound(shielded, { A: 'def', B: 'atk' });
  const took = 500 - shielded.mem.A.hp, full = 500 - plain.mem.A.hp;
  ok('щит режет урон вдвое', took === Math.round(full / 2), `щит=${took} без щита=${full}`);
}
{
  // сильный удар в щит оглушает атакующего
  const R = duel(hero('A', 0), hero('B', 1));
  dRound(R, { A: 'pow', B: 'def' });
  ok('сильный удар в щит оглушает атакующего', R.mem.A.stun > R.r - 1, `stun=${R.mem.A.stun} r=${R.r}`);
}
{
  // зелье: лечит 35% максимума и тратится
  const R = duel(hero('A', 0, { hp: 100, pot: 1 }), hero('B', 1));
  dRound(R, { A: 'pot' });
  // лечение 35% максимума (175), но в раунде A ещё и получает удар противника (50)
  ok('зелье лечит 35% максимума', R.mem.A.hp === 100 + 175 - 50, `hp=${R.mem.A.hp}`);
  ok('зелье тратится', R.mem.A.pot === 0);
}
{
  // сильный удар вдвое сильнее обычного
  const norm = duel(hero('A', 0), hero('B', 1));
  dRound(norm, { A: 'atk', B: 'atk' });
  const pow = duel(hero('A', 0), hero('B', 1));
  dRound(pow, { A: 'pow', B: 'atk' });
  const dn = 500 - norm.mem.B.hp, dp = 500 - pow.mem.B.hp;
  ok('сильный удар вдвое сильнее', dp === dn * 2, `обычный=${dn} сильный=${dp}`);
}
{
  // перезарядка сильного удара
  const R = duel(hero('A', 0, { pcd: 9 }), hero('B', 1), 1);
  const norm = duel(hero('A', 0), hero('B', 1));
  dRound(norm, { A: 'atk', B: 'atk' });
  dRound(R, { A: 'pow', B: 'atk' });
  ok('перезарядка: сильный удар не проходит', R.mem.B.hp === norm.mem.B.hp, `hp=${R.mem.B.hp} обычный=${norm.mem.B.hp}`);
}
{
  // шаман: лечит 25% и бьёт слабее
  const R = duel(hero('A', 0, { cls: 'shaman', hp: 400 }), hero('B', 1));
  dRound(R, { A: 'sk', B: 'atk' });
  // лечение 25% максимума (125) минус входящий удар (50)
  ok('шаман лечит себя на 25% максимума', R.mem.A.hp === 400 + 125 - 50, `hp=${R.mem.A.hp}`);
  // урон = max(25% атаки, атака) * 0.5 = 25 — множитель применяется после нижней границы
  ok('шаман бьёт вполсилы', (500 - R.mem.B.hp) === 25, `урон=${500 - R.mem.B.hp}`);
}
{
  // победа по здоровью
  const R = duel(hero('A', 0, { hp: 10 }), hero('B', 1));
  dRound(R, { A: 'atk', B: 'atk' });
  ok('нулевое здоровье = поражение', R.st === 'end' && R.win === 'B', `st=${R.st} win=${R.win}`);
}
{
  // ничья: оба пали
  const R = duel(hero('A', 0, { hp: 10 }), hero('B', 1, { hp: 10 }));
  dRound(R, { A: 'atk', B: 'atk' });
  ok('оба пали = ничья', R.st === 'end' && R.win === 'draw', `win=${R.win}`);
}
{
  // лимит раундов: побеждает тот, у кого больше здоровья
  const R = duel(hero('A', 0, { hp: 400 }), hero('B', 1, { hp: 300 }), 15);
  dRound(R, { A: 'atk', B: 'atk' });
  ok('после 15 раундов решает здоровье', R.st === 'end' && R.win === 'A', `st=${R.st} win=${R.win}`);
}
{
  // журнал раунда не растёт бесконечно
  const R = duel(hero('A', 0), hero('B', 1));
  for (let i = 0; i < 60; i++) dRound(R, { A: 'atk', B: 'atk' });
  ok('журнал ограничен 40 строками', R.log.length <= 40, `строк=${R.log.length}`);
}

// ---------- ограничение частоты ----------
{
  const lim = makeLimiter({ cap: 5, perSec: 1 / 60 });  // 5 сразу, потом по одному в минуту
  let n = 0;
  for (let i = 0; i < 20; i++) if (lim('k')) n++;
  ok('лимит пропускает всплеск и режет дальше', n === 5, `пропущено=${n}`);
  ok('Retry-After считается', lim.retryAfter('k') >= 1);
}
{
  const lim = makeLimiter({ cap: 3, perSec: 1000 });   // быстрое восстановление
  for (let i = 0; i < 3; i++) lim('k');
  ok('корзина исчерпана', lim('k') === false);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  wait(5).then(() => {
    ok('корзина восстанавливается', lim('k') === true);
    part2();
  });
}
function part2() {
{
  const lim = makeLimiter({ cap: 2, perSec: 0.0001 });
  lim('a'); lim('a');
  ok('у каждого ключа своя корзина', lim('b') === true);
}
  Math.random = realRandom;
  console.log('\n  пройдено: ' + passed + ', провалено: ' + failed + '\n');
  process.exit(failed ? 1 : 0);
}

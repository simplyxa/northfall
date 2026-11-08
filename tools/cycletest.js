// Тесты мирового цикла: босс, территории, войны, казна клана, рейтинг дуэли.
// Чистые функции сервера — без Firestore и без сети.
//
// Запуск: node tools/cycletest.js
'use strict';
const ARENA = require('../server/arena');
const CYCLE = require('../server/cycle');
const RAID = require('../server/raid');

let ok = 0, bad = 0;
const T = (name, cond, extra) => {
  if (cond) { ok++; console.log('  ✓ ' + name); }
  else { bad++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 0 : eps);

// ---------- очки умений ----------
console.log('\nОчки умений (сервер урезает до базы класса + 3 за уровень):');
{
  const s = { lvl: 10, st: { str: 20, hp: 20, arm: 10, reg: 10, en: 5 } }; // 65 при потолке 52
  const f = ARENA.clampStats(s);
  T('накрученные очки урезаны', !!f);
  const sum = f ? ['str', 'hp', 'arm', 'reg', 'en'].reduce((a, k) => a + f[k], 0) : 0;
  T('сумма равна потолку', sum === 25 + 3 * 9, 'sum=' + sum);
  T('честные очки не трогаются', ARENA.clampStats({ lvl: 10, st: { str: 10, hp: 10, arm: 8, reg: 8, en: 5 } }) === null);
  T('уровень 1: только база', ARENA.clampStats({ lvl: 1, st: { str: 30, hp: 10, arm: 5, reg: 5, en: 5 } }) !== null);
}

// ---------- рейтинг дуэли ----------
console.log('\nРейтинг дуэли (считает сервер, не клиент):');
{
  const st = ARENA.readState({ rating: 1000, srat: 0, atk: 5, atkt: Date.now() }, Date.now());
  const g = ARENA.duelRating(st, 1, 1000);
  T('победа даёт рейтинг', g > 0 && st.rt === 1000 + g, 'g=' + g);
  const st2 = ARENA.readState({ rating: 1000, srat: 0, atk: 5, atkt: Date.now() }, Date.now());
  const l = ARENA.duelRating(st2, 0, 1000);
  T('поражение отнимает рейтинг', l < 0 && st2.rt === 1000 + l, 'l=' + l);
  const st3 = ARENA.readState({ rating: 1000, srat: 0, atk: 5, atkt: Date.now() }, Date.now());
  T('ничья не меняет рейтинг', ARENA.duelRating(st3, 0.5, 1000) === 0 && st3.rt === 1000);
  // сильный соперник — больше очков, слабый — меньше
  const hi = ARENA.readState({ rating: 1000, srat: 0, atk: 5, atkt: Date.now() }, Date.now());
  const lo = ARENA.readState({ rating: 1000, srat: 0, atk: 5, atkt: Date.now() }, Date.now());
  const gh = ARENA.duelRating(hi, 1, 1400), gl = ARENA.duelRating(lo, 1, 600);
  T('рейтинг зависит от соперника', gh > gl, gh + ' vs ' + gl);
  T('прибавка не больше 40', gh <= 40 && gl <= 40);
  T('прибавка не меньше 8', gh >= 8 && gl >= 8);
}

// ---------- дуэль целиком ----------
console.log('\nДуэль: сервер начисляет рейтинг, билет и дневной рейтинг:');
{
  const now = Date.now();
  const prevs = {
    a: { rating: 1000, srat: 100, atk: 3, atkt: now, dr: 1000, dn: 0, dw: 0, day: ARENA.dayNum(now) },
    b: { rating: 1200, srat: 200, atk: 3, atkt: now, dr: 1000, dn: 0, dw: 0, day: ARENA.dayNum(now) }
  };
  const res = ARENA.scoreDuel({ a: { lv: 10 }, b: { lv: 12 } }, 'a', prevs, now);
  T('победитель получил рейтинг', res.a.rt > 1000, 'rt=' + res.a.rt);
  T('проигравший потерял рейтинг', res.b.rt < 1200, 'rt=' + res.b.rt);
  T('билет списан', res.a.atk === 2 && res.b.atk === 2, res.a.atk + '/' + res.b.atk);
  T('дневной рейтинг посчитан', res.a.dr !== 1000 && res.b.dr !== 1000);
  T('счётчик боёв вырос', res.a.dn === 1 && res.b.dn === 1);
  T('победа даёт золото', res.a.g > 0 && res.b.g === 0);
  T('очки войны у победителя', res.a.war === 10 && res.b.war === 0);
  // без явного победителя результат не засчитывается
  T('битый документ не засчитан', ARENA.scoreDuel({ a: { lv: 1 }, b: { lv: 1 } }, 'xyz', prevs, now) === null);
}

// ---------- мировой босс ----------
console.log('\nМировой босс: здоровье и потолок урона:');
{
  T('базовое здоровье', CYCLE.bossMax(null) === 40000, String(CYCLE.bossMax(null)));
  const y = { day: 1, max: 40000, killed: true, kt: 1 * 86400000 + 3600000 }; // убит за час
  T('убили быстро — завтра крепче', CYCLE.bossMax(y) > 40000, String(CYCLE.bossMax(y)));
  const n = { day: 1, max: 100000, killed: false };
  T('не убили — слабее', CYCLE.bossMax(n) === 80000, String(CYCLE.bossMax(n)));
  T('ниже базового не опускается', CYCLE.bossMax({ day: 1, max: 40000, killed: false }) === 40000);
  const hero = { st: { str: 40 }, eq: { a: { b: { atk: 80 } } } };
  const bound = CYCLE.atkBound(hero);
  T('граница атаки считается от снаряжения', bound > 40, String(bound));
  const cap = CYCLE.bossDayCap(hero);
  T('потолок урона за сутки ограничен', cap > 0 && cap < 200000, String(cap));
  const cheater = { st: { str: 100000 }, eq: {} };
  T('накрученные очки умений не дают потолка', CYCLE.bossDayCap(cheater) > 0);
}

// ---------- казна и постройки ----------
console.log('\nКазна клана:');
{
  const tr = CYCLE.treasury([{ gold: 500, iron: 20 }, { gold: 100, iron: 5 }], { gold: 100, iron: 5 });
  T('свободно в казне считается верно', tr.g === 500 && tr.i === 20, JSON.stringify(tr));
  T('уровень клана по опыту', CYCLE.cLv(0) === 1 && CYCLE.cLv(22500) === 2, String(CYCLE.cLv(22500)));
  T('потолок уровня 10', CYCLE.cLv(99999999) === 10, String(CYCLE.cLv(99999999)));
}

// ---------- опыт до уровня (рейд) ----------
console.log('\nРейд: опыт за уровень считается по той же формуле:');
{
  const xpNeed = L => { const m = L <= 10 ? .3 : Math.min(1, .3 + .07 * (L - 10)); return Math.round((20 * L * L + .8 * L * L * L) * m); };
  T('опыт на 1 уровне', xpNeed(1) === 6, String(xpNeed(1)));
  T('опыт на 10 уровне', xpNeed(10) === 840, String(xpNeed(10)));
  T('опыт на 30 уровне больше', xpNeed(30) > xpNeed(10));
}

// ---------- статическая проверка транзакций ----------
console.log('\nТранзакции Firestore:');
{
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, '..', 'server');
  const bads = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // запрос внутри транзакции запрещён: Firestore умеет в транзакции только чтение документов
    src.split('\n').forEach((ln, i) => {
      if (/tx\.get\([^)]*where\(/.test(ln)) bads.push(f + ':' + (i + 1) + ' — запрос внутри транзакции: ' + ln.trim().slice(0, 90));
    });
  }
  T('в транзакциях нет запросов (только чтение документов)', bads.length === 0, bads.join(' | '));
}

console.log('\nИтог: ' + ok + ' прошло, ' + bad + ' провалено');
process.exit(bad ? 1 : 0);

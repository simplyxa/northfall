// Ремесло: профессия (одна), материалы, очередь крафта. Всё считает сервер:
// рецепты, стоимость, время, дневной лимит и редкость результата. Состояние живёт в save.cf
// и защищено от записи клиентом (см. guard в saves.js).
//   cf = { p: 'smith'|'alch'|'rune', x: опыт профессии, q: {r, a, t0, te, n}|null, d: сутки, n: крафтов за сутки }
'use strict';
const MATS = ['hide', 'bone', 'ore', 'herb'];
const DAY = 86400000, DAILY = 12, SWITCH_COST = 5000;
const PROFS = ['smith', 'alch', 'rune'];
const SLOTS = ['w', 'h', 'a', 'g', 'b', 'r', 'c', 'p', 'n', 'o'];
const SETLV = [1, 8, 15, 22, 30, 30, 12, 24, 30];   // 5 — набор Одина (не крафтится); 6–8 — наборы только для крафта
const RUNES = ['str', 'hp', 'arm', 'reg', 'en'];
const pLevel = x => Math.min(10, 1 + Math.floor(Math.sqrt(Math.max(0, x | 0) / 25)));

// Кузнец: набор tr 0..4, нужен уровень профессии и героя
const FORGE = {
  0: { pl: 1, iron: 40, ore: 3, hide: 2, gold: 100, min: 10, xp: 10 },
  1: { pl: 2, iron: 90, ore: 5, hide: 3, gold: 300, min: 25, xp: 20 },
  2: { pl: 3, iron: 170, ore: 8, hide: 5, gold: 800, min: 60, xp: 30 },
  3: { pl: 5, iron: 300, ore: 12, hide: 8, gold: 2000, min: 120, xp: 45 },
  4: { pl: 7, iron: 500, ore: 18, hide: 12, gold: 5000, min: 240, xp: 60 },
  // наборы, которых нет в добыче: только крафт
  6: { pl: 2, iron: 70, ore: 4, hide: 6, bone: 2, gold: 200, min: 20, xp: 18 },    // следопыта, 12 ур.
  7: { pl: 5, iron: 260, ore: 12, bone: 8, gold: 1500, min: 100, xp: 40 },         // рунного кузнеца, 24 ур.
  8: { pl: 7, iron: 450, ore: 14, hide: 10, bone: 10, gold: 4000, min: 200, xp: 55 } // ледяного стража, 30 ур.
};
// Алхимик: партии бутылок
const BREW = {
  10: { pl: 1, herb: 3, gold: 40, min: 10, xp: 8 },
  30: { pl: 2, herb: 8, gold: 110, min: 30, xp: 20 },
  60: { pl: 4, herb: 14, gold: 200, min: 60, xp: 36 }
};
// Эликсиры: a — сила, h — стойкость, d — броня; партия из 2
const ELIX = { pl: 3, herb: 6, bone: 3, gold: 150, min: 20, xp: 25, n: 2 };
const ELK = ['a', 'h', 'd'];
// Рунник: камень уровня g 0..4
const RUNEC = [
  { pl: 1, dust: 30, bone: 1, min: 10, xp: 10 },
  { pl: 2, dust: 80, bone: 2, min: 30, xp: 20 },
  { pl: 4, dust: 200, bone: 4, min: 60, xp: 35 },
  { pl: 6, dust: 500, bone: 7, min: 120, xp: 55 },
  { pl: 8, dust: 1200, bone: 12, min: 240, xp: 80 }
];

function init(s) {
  const c = s.cf && typeof s.cf === 'object' ? s.cf : {};
  s.cf = { p: PROFS.includes(c.p) ? c.p : '', x: Math.max(0, c.x | 0), q: c.q && c.q.r ? c.q : null, d: c.d | 0, n: c.n | 0 };
  s.mat = s.mat && typeof s.mat === 'object' ? s.mat : {};
  for (const m of MATS) s.mat[m] = Math.max(0, s.mat[m] | 0);
  return s.cf;
}

// returns {need:{...}} or throws via fail(code,msg)
function start(s, o, now, fail) {
  const c = init(s), day = Math.floor(now / DAY);
  if (!c.p) throw fail(400, 'Сначала выбери профессию');
  if (c.q) throw fail(409, 'Мастерская занята');
  if (c.d !== day) { c.d = day; c.n = 0; }
  if (c.n >= DAILY) throw fail(409, 'Дневной лимит крафта: ' + DAILY);
  const pl = pLevel(c.x), r = String(o.r || '');
  let rec, a = {}, cost = {};
  if (r === 'forge') {
    if (c.p !== 'smith') throw fail(400, 'Это ремесло кузнеца');
    const tr = o.tr | 0, slot = String(o.slot || '');
    if (!FORGE[tr] || !SLOTS.includes(slot)) throw fail(400, 'Неверный рецепт');
    rec = FORGE[tr]; a = { slot, tr };
    if ((s.lvl | 0) < SETLV[tr]) throw fail(409, 'Нужен ' + SETLV[tr] + ' уровень героя');
    cost = { iron: rec.iron, ore: rec.ore, gold: rec.gold }; if (rec.hide) cost.hide = rec.hide; if (rec.bone) cost.bone = rec.bone;
  } else if (r === 'brew') {
    if (c.p !== 'alch') throw fail(400, 'Это ремесло алхимика');
    const n = o.n | 0; rec = BREW[n]; if (!rec) throw fail(400, 'Неверный рецепт');
    a = { n }; cost = { herb: rec.herb, gold: rec.gold };
  } else if (r === 'elix') {
    if (c.p !== 'alch') throw fail(400, 'Это ремесло алхимика');
    const t = String(o.t || ''); if (!ELK.includes(t)) throw fail(400, 'Неверный рецепт');
    rec = ELIX; a = { t }; cost = { herb: rec.herb, bone: rec.bone, gold: rec.gold };
  } else if (r === 'rune') {
    if (c.p !== 'rune') throw fail(400, 'Это ремесло рунника');
    const g = o.g | 0, t = String(o.t || '');
    if (!(g >= 0 && g <= 4) || !RUNES.includes(t)) throw fail(400, 'Неверный рецепт');
    rec = RUNEC[g]; a = { k: t + g }; cost = { dust: rec.dust, bone: rec.bone };
  } else throw fail(400, 'Неизвестный рецепт');
  if (pl < rec.pl) throw fail(409, 'Нужен ' + rec.pl + ' уровень профессии');
  for (const [k, v] of Object.entries(cost)) {
    const have = k === 'gold' ? +s.gold || 0 : k === 'iron' || k === 'dust' ? s[k] | 0 : s.mat[k] | 0;
    if (have < v) throw fail(409, 'Не хватает: ' + ({ gold: 'серебра', iron: 'железа', dust: 'пыли', hide: 'шкур', bone: 'костей', ore: 'руды', herb: 'трав' })[k]);
  }
  for (const [k, v] of Object.entries(cost)) {
    if (k === 'gold') s.gold = (+s.gold || 0) - v; else if (k === 'iron' || k === 'dust') s[k] = (s[k] | 0) - v; else s.mat[k] -= v;
  }
  c.n++;
  c.q = { r, a, t0: now, te: now + rec.min * 60000, xp: rec.xp };
  return { q: c.q };
}

function rollRar(pl, tr) {
  const x = Math.random(), legend = tr >= 2 ? .01 * pl : 0, epic = .08 + .03 * pl, rare = .35 + .04 * pl;
  return x < legend ? 3 : x < legend + epic ? 2 : x < legend + epic + rare ? 1 : 0;
}

function claim(s, now, fail) {
  const c = init(s);
  if (!c.q) throw fail(409, 'Нечего забирать');
  if (now < c.q.te) throw fail(409, 'Ещё не готово');
  const q = c.q, pl = pLevel(c.x); let out;
  if (q.r === 'forge') out = { kind: 'item', slot: q.a.slot, tr: q.a.tr, rar: rollRar(pl, q.a.tr) };
  else if (q.r === 'elix') { s.elx = s.elx && typeof s.elx === 'object' ? s.elx : {}; s.elx[q.a.t] = (s.elx[q.a.t] | 0) + ELIX.n; out = { kind: 'elix', t: q.a.t, n: ELIX.n }; }
  else if (q.r === 'brew') { s.pt = s.pt && typeof s.pt === 'object' ? s.pt : {}; s.pt.b = (s.pt.b | 0) + q.a.n; out = { kind: 'bottle', n: q.a.n }; }
  else { s.runes = s.runes && typeof s.runes === 'object' ? s.runes : {}; s.runes[q.a.k] = (s.runes[q.a.k] | 0) + 1; out = { kind: 'rune', k: q.a.k }; }
  const was = pl; c.x += q.xp | 0; c.q = null;
  out.xp = q.xp | 0; out.pl = pLevel(c.x); out.up = out.pl > was ? 1 : 0;
  return out;
}

function pick(s, o, now, fail) {
  const c = init(s), p = String(o.p || '');
  if (!PROFS.includes(p)) throw fail(400, 'Неизвестная профессия');
  if (c.q) throw fail(409, 'Сначала забери готовое');
  if (c.p === p) throw fail(409, 'Эта профессия уже выбрана');
  if (c.p) { if ((+s.gold || 0) < SWITCH_COST) throw fail(409, 'Смена профессии стоит ' + SWITCH_COST + ' серебра'); s.gold -= SWITCH_COST; c.x = 0; }
  c.p = p;
  return { p };
}

// защита от накрутки материалов обычным сохранением: рост за запись ограничен
function clampMats(prev, s, dt) {
  const pm = prev && prev.mat || {}, cap = 40 + Math.max(0, dt) / 1000 * .5, m = s.mat && typeof s.mat === 'object' ? s.mat : {}, out = {};
  for (const k of MATS) out[k] = Math.max(0, Math.min(m[k] | 0, (pm[k] | 0) + cap));
  for (const k of MATS) out[k] = Math.floor(out[k]);
  s.mat = out;
}
// cf меняет только сервер
function lockCf(prev, s) { if (prev && prev.cf) s.cf = prev.cf; else delete s.cf; }

module.exports = { ELIX, MATS, PROFS, DAILY, SWITCH_COST, FORGE, BREW, RUNEC, pLevel, init, start, claim, pick, clampMats, lockCf };

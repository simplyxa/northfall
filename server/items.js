// Проверка вещей на сервере: характеристики не могут быть выше, чем позволяют формулы игры
// для такого слота, редкости и уровня вещи (с запасом 15%). Завышенное урезается.
// Формулы повторяют игру: PRIM/EXTRA/RAR/SETLV (gen и scaleTo).
'use strict';
const PRIM = { w: ['atk', L => 3 + 2.2 * L], h: ['def', L => 1 + .8 * L], a: ['def', L => 2 + 1.4 * L], g: ['atk', L => 1 + .8 * L], b: ['def', L => 1 + .6 * L], r: ['hp', L => 6 + 3 * L], c: ['hp', L => 4 + 2 * L], p: ['def', L => 1 + .9 * L], n: ['atk', L => 1 + .6 * L], o: ['hp', L => 5 + 2.2 * L] };
const EXTRA = { atk: L => .6 * L + 1, def: L => .5 * L + 1, hp: L => 2.5 * L + 3, reg: L => 1 + Math.floor(L / 6), en: L => 1 + Math.floor(L / 8), crit: L => 2 + Math.floor(L / 4) };
const RARM = [1, 1.3, 1.7, 2.2, 2.8];
const FLAT = { crit: 1, reg: 1, en: 1 };
const LVMAX = 60, TOL = 1.15;
const RUNEOK = /^(str|hp|arm|reg|en)[0-4]$/;

function statF(slot, k, L) { return k === PRIM[slot][0] ? PRIM[slot][1](L) : EXTRA[k](L); }

// возвращает null, если вещь в порядке, иначе описание того, что поправлено (вещь правится на месте)
function check(it) {
  if (!it || typeof it !== 'object' || !PRIM[it.slot] || !it.b || typeof it.b !== 'object') return null;
  const why = [];
  const rar = Math.max(0, Math.min(4, it.rar | 0)); if (it.rar !== rar) { it.rar = rar; why.push('rar'); }
  const lv = Math.max(1, Math.min(LVMAX + 5, +it.lv || 1)); if (it.lv !== lv) { it.lv = lv; why.push('lv'); }
  const up = Math.max(0, Math.min(10, it.up | 0)); if ((it.up | 0) !== up) { it.up = up; why.push('up'); }
  const t5 = it.tr === 5 ? 1.2 : 1, pk = PRIM[it.slot][0];
  const keys = Object.keys(it.b);
  for (const k of keys) {
    if (!(k === pk || EXTRA[k])) { delete it.b[k]; why.push('key:' + k); continue; }
    const m = k === pk ? RARM[rar] : FLAT[k] ? 1 : RARM[rar] * .6;
    const cap = Math.ceil(statF(it.slot, k, lv) * m * t5 * TOL) + 2;
    const v = +it.b[k];
    if (!Number.isFinite(v) || v < 0) { it.b[k] = 1; why.push(k); }
    else if (v > cap) { it.b[k] = cap; why.push(k + ':' + v + '>' + cap); }
  }
  // дополнительных характеристик не больше, чем позволяет редкость
  const extra = Object.keys(it.b).filter(k => k !== pk);
  if (extra.length > rar) { for (const k of extra.slice(rar)) delete it.b[k]; why.push('extra'); }
  if (Array.isArray(it.rn)) {
    const rn = it.rn.filter(r => typeof r === 'string' && RUNEOK.test(r)).slice(0, 6);
    if (rn.length !== it.rn.length) { it.rn = rn; why.push('rn'); }
  }
  return why.length ? why.join(',') : null;
}

// проверить все вещи героя; вернуть список исправленных (для флага и для игры)
module.exports = function checkHero(s) {
  const fixed = [];
  const one = (it, where) => { const w = check(it); if (w) fixed.push({ uid: it.uid, where, why: w, item: it }); };
  if (Array.isArray(s.inv)) for (const it of s.inv) one(it, 'inv');
  if (s.eq && typeof s.eq === 'object') for (const [k, it] of Object.entries(s.eq)) if (it) one(it, 'eq:' + k);
  return fixed;
};

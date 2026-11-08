// Серверная власть над рейтингом, сезоном и билетами арены.
//
// Раньше рейтинг, счётчики побед и сезонные очки считал сам клиент и писал их
// в карточку игрока — то есть игрок мог дописать себе любой рейтинг прямо
// из консоли браузера. Теперь эти числа считает сервер.
//
// Арена целиком считается на клиенте (бои с копиями героев), поэтому сервер
// не видит сами бои — он видит только заявку клиента и решает, можно ли её
// засчитать. Заявка принимается, только если есть билет арены: билеты
// начисляются по часам и не копятся. Это ограничивает и честного игрока, и
// читера одинаково.
//
// Чистые функции без побочных эффектов — их покрывает tools/arenatest.js.
'use strict';

const ATK = 10;                  // максимум билетов арены
const ATH = 3600000;             // один билет в час
const WIN_MIN = 8, WIN_MAX = 46; // границы прибавки рейтинга за победу (боты 14..46, PvP 8..40)
const LOSE_MIN = 1, LOSE_MAX = 25; // границы списания за поражение (боты 8..20, PvP 5..25)
const WEEK = 604800000;          // сезон — неделя
const DAYMS = 86400000;          // сутки

const season = now => Math.floor(now / WEEK);
// сутки в игре считаются по Израилю (+2 часа) — так же, как в клиенте
const dayNum = now => Math.floor((now + 2 * 3600000) / DAYMS);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Состояние из прошлого сохранения. Доверяем только тому, что записали сами.
function readState(prev, now) {
  const s = prev || {};
  const cur = season(now);
  let atk = s.atk == null ? ATK : clamp(s.atk | 0, 0, ATK);
  let atkt = +s.atkt || now;
  if (atk < ATK) {
    // начислить билеты за прошедшие часы (не больше одного в час)
    const n = Math.floor((now - atkt) / ATH);
    if (n > 0) { atk = Math.min(ATK, atk + n); atkt = atk >= ATK ? now : atkt + n * ATH; }
  } else atkt = now;
  let rt = s.rating == null ? 1000 : Math.max(0, s.rating | 0);
  let srt = Math.max(0, s.srat | 0);
  let sid = s.sid == null ? 0 : s.sid | 0;
  let psid = s.psid == null ? 0 : s.psid | 0;
  let psrat = Math.max(0, s.psrat | 0);
  if (!sid) sid = cur;
  else if (sid !== cur) { psid = sid; psrat = srt; sid = cur; srt = 0; } // новый сезон
  // дневной рейтинг лайв-арены: тоже серверное число
  const day = dayNum(now);
  let dr = s.dr == null ? 1000 : Math.max(0, s.dr | 0);
  let dn = Math.max(0, s.dn | 0), dw = Math.max(0, s.dw | 0);
  // Дуэльный обработчик сохраняет метку в _ar.d; читаем её как основной источник.
  // s.day оставлен для совместимости со старыми тестовыми/переходными сохранениями.
  const savedDay = s._ar && Number.isFinite(+s._ar.d) ? (+s._ar.d | 0) : (s.day == null ? null : s.day | 0);
  if (savedDay !== day) { dr = 1000; dn = 0; dw = 0; } // новые сутки
  return { rt, srt, sid, psid, psrat, atk, atkt, dr, dn, dw, day };
}

// Заявка клиента: подписанная прибавка рейтинга (победа — положительная,
// поражение — отрицательное). Без заявки ничего не меняется.
function applyResult(st, claim) {
  const out = { rt: st.rt, srt: st.srt, atk: st.atk, atkt: st.atkt, used: 0, rej: 0 };
  if (!claim || typeof claim.d !== 'number' || !isFinite(claim.d) || !claim.d) return out;
  if (st.atk < 1) { out.rej = 1; return out; }   // билета нет — результат не засчитываем
  out.atk = st.atk - 1;
  out.used = 1;
  if (claim.d > 0) {
    const g = clamp(Math.round(claim.d), WIN_MIN, WIN_MAX);
    out.rt = st.rt + g;
    out.srt = st.srt + g;
  } else {
    const l = clamp(Math.round(-claim.d), LOSE_MIN, LOSE_MAX);
    out.rt = Math.max(0, st.rt - Math.min(l, st.rt));
    out.srt = Math.max(0, st.srt - l);
  }
  return out;
}

// Счётчики побед/поражений клиент тоже считает сам. Растём они от боёв,
// поэтому ограничиваем прирост временем между сохранениями: за секунду можно
// закрыть примерно одно убийство, плюс небольшой запас.
function clampWins(prev, now, dt) {
  const p = prev || {};
  const w = p.win == null ? 0 : Math.max(0, p.win | 0);
  const l = p.lose == null ? 0 : Math.max(0, p.lose | 0);
  const gap = Math.max(1000, Math.min(60000, dt || 5000));
  const max = Math.ceil(gap / 1500) + 2;
  return { win: w, lose: l, max };
}

// Уровень: правила Firestore раньше ограничивали его (не выше 60 и не больше
// +10 за запись). Когда запись в saves перевели на сервер, эту проверку
// перенесли сюда — иначе уровень можно было бы выписать напрямую.
const LVL_MAX = 60, LVL_STEP = 10;
function clampLevel(prev, claimed) {
  const p = prev || {};
  const fresh = p.lvl == null;                       // сервер ещё не видел этого игрока
  const base = fresh ? 1 : Math.max(1, p.lvl | 0);
  const v = claimed == null ? base : Math.max(1, claimed | 0);
  // для нового игрока — тот же потолок, что и у старых правил Firestore (60)
  const cap = fresh ? LVL_MAX : Math.min(LVL_MAX, base + LVL_STEP);
  return clamp(v, base, cap);
}

// Очки умений: база класса (25 очков) + 3 очка за каждый уровень.
// Раньше их писал только клиент — можно было выписать себе сколько угодно,
// а от них зависит атака (и потолок урона по мировому боссу).
// Возвращает исправленные статы или null, если всё в порядке.
function clampStats(s) {
  const st = (s && s.st) || {};
  const sum = ['str', 'hp', 'arm', 'reg', 'en'].reduce((a, k) => a + Math.max(0, st[k] | 0), 0);
  const cap = 25 + 3 * (Math.max(1, (s && s.lvl) | 0) - 1);
  if (sum <= cap) return null;
  const out = Object.assign({}, st);
  let over = sum - cap;
  for (const k of ['str', 'hp', 'arm', 'reg', 'en']) {
    if (!over) break;
    const cut = Math.min(over, Math.max(0, out[k] | 0));
    out[k] = (out[k] | 0) - cut; over -= cut;
  }
  return out;
}

// Итог дуэли лайв-арены: сервер считает Эло сам.
// sc — очки (1 победа, 0.5 ничья, 0 поражение), odr — дневной рейтинг соперника.
function applyDuel(st, sc, odr) {
  const r0 = st.dr;
  const ex = 1 / (1 + Math.pow(10, ((odr == null ? 1000 : odr) - r0) / 400));
  const dR = Math.round(32 * (sc - ex));
  st.dr = Math.max(0, r0 + dR);
  st.dn = (st.dn | 0) + 1;
  if (sc === 1) st.dw = (st.dw | 0) + 1;
  return { sc, dR, ex, dr: st.dr, dn: st.dn, dw: st.dw };
}

// Золото за победу в лайв-арене — как в клиенте: 50 + 15 за уровень
const duelGold = lv => 50 + 15 * (Math.max(1, lv | 0));

// Основной (сезонный) рейтинг за дуэль: сервер начисляет его сам.
// Раньше рейтинг арены приходил заявкой клиента — игрок мог заявить победу
// без боя и получить полные +40 очков по билету.
function duelRating(st, sc, oppRating) {
  const diff = (oppRating == null ? 1000 : oppRating) - st.rt;
  if (sc === 1) {
    const w = clamp(Math.round(20 + diff / 20), WIN_MIN, 40);
    st.rt += w; st.srt += w;
    return w;
  }
  if (sc === 0) {
    const l = clamp(12, LOSE_MIN, LOSE_MAX);
    const r = Math.min(l, st.rt);
    st.rt -= r; st.srt = Math.max(0, st.srt - l);
    return -r;
  }
  return 0;
}

// Итог дуэли лайв-арены для обоих участников.
// members — {uid: {lv}}, win — uid победителя или 'draw', prevs — прошлые сохранения.
function scoreDuel(members, win, prevs, now) {
  const ids = Object.keys(members || {});
  if (ids.length !== 2) return null;
  // без явного победителя или ничьей результат не засчитываем — иначе битый документ
  // отнял бы рейтинг у обоих участников
  if (win !== 'draw' && !ids.includes(win)) return null;
  const st = {}, out = {};
  for (const id of ids) st[id] = readState((prevs && prevs[id]) || null, now);
  const rt0 = {}; for (const id of ids) rt0[id] = st[id].rt;   // рейтинг соперника — до правок
  for (const id of ids) {
    const oid = ids.find(x => x !== id);
    const sc = win === 'draw' ? 0.5 : (win === id ? 1 : 0);
    const r = applyDuel(st[id], sc, st[oid].dr);
    // основной (сезонный) рейтинг — тоже сервер; билет за дуэль списывает сервер
    let rt = 0, noT = 0;
    if (st[id].atk >= 1) { rt = duelRating(st[id], sc, rt0[oid]); st[id].atk -= 1; }
    else noT = 1;
    out[id] = {
      sc, dR: r.dR, dr: r.dr, dn: r.dn, dw: r.dw,
      g: sc === 1 ? duelGold((members[id] && members[id].lv) || 1) : 0,
      rt: st[id].rt, srt: st[id].srt, atk: st[id].atk, atkt: st[id].atkt, noT,
      war: sc === 1 ? 10 : 0   // очки клановой войны
    };
  }
  return out;
}

module.exports = { ATK, ATH, WIN_MIN, WIN_MAX, LOSE_MIN, LOSE_MAX, WEEK, DAYMS, season, dayNum, readState, applyResult, applyDuel, duelGold, duelRating, scoreDuel, clampWins, clampLevel, clampStats, LVL_MAX, LVL_STEP };

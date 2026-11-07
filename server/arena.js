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

const season = now => Math.floor(now / WEEK);
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
  return { rt, srt, sid, psid, psrat, atk, atkt };
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

module.exports = { ATK, ATH, WIN_MIN, WIN_MAX, LOSE_MIN, LOSE_MAX, WEEK, season, readState, applyResult, clampWins, clampLevel, LVL_MAX, LVL_STEP };

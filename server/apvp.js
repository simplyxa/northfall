// Арена против копии героя: бой ведёт сервер.
//
// Раньше весь бой считался на клиенте: игрок сам моделировал схватку с копией
// другого героя, а потом заявлял результат. Рейтинг можно было накрутить
// заявкой без боя, а билет арены списывался у клиента и тут же возвращался
// сервером (сервер о бою не знал).
//
// Теперь сервер сам держит бой: считает заряд удара, удары врага, блок,
// бутылки и навыки, решает исход и начисляет рейтинг и билет. Клиент только
// рисует присланное состояние и отправляет ходы.
//
// Характеристики берём из сохранения игрока. Бонусы сета и питомца сервер не
// учитывает (сложность набора в сервере не продублирована) — из-за этого
// бойцы с набором получают чуть меньше силы, чем в клиентском бою.
'use strict';
const ARENA = require('./arena');

const TICK = 250;        // тик боя, мс
const CH_T = 5;          // время заряда удара, с
const E_T = 5;           // период атаки врага, с
const FIGHT_T = 45000;   // максимум боя, мс
const SKQ = { rage: [2, 2.2, 2.4, 2.7, 3], roar: [40, 45, 50, 55, 60], shot: [1.2, 1.4, 1.6, 1.85, 2.2], trap: [4, 4.5, 5, 6, 7], totem: [25, 30, 35, 42, 50], skin: [6, 7, 8, 9, 10] };
const SKCD = [1, .95, .9, .85, .8];
const SKL = { berserk: [['rage', 20], ['roar', 25]], hunter: [['shot', 15], ['trap', 20]], shaman: [['totem', 25], ['skin', 30]] };
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

module.exports = function apvp(getDb) {
  const rooms = new Map();   // uid → R
  const starting = new Set(); // защита от двойного вызова до завершения транзакции
  const D = () => getDb();

  // ---- характеристики по сохранению ----
  const eqSum = (S, k) => {
    let v = 0; const eq = (S && S.eq) || {};
    for (const s in eq) { const it = eq[s]; if (it && it.b && it.b[k]) v += it.b[k]; }
    return v;
  };
  function hero(S) {
    const st = (S && S.st) || {};
    return {
      atk: Math.max(1, Math.round((st.str | 0) * 2 + eqSum(S, 'atk'))),
      def: Math.max(0, (st.arm | 0) + eqSum(S, 'def')),
      mhp: Math.max(1, Math.round(40 + (st.hp | 0) * 8 + (S.lvl | 0) * 10 + eqSum(S, 'hp'))),
      crit: Math.min(60, 10 + eqSum(S, 'crit'))
    };
  }

  // ---- состояние боя для клиента ----
  function pub(R) {
    return {
      pid: R.oid, st: R.st, win: R.win, clk: R.clk, ch: R.ch, ech: R.ech ? clamp((R.clk - (R.ech - E_T * 1000)) / (E_T * 1000), 0, 1) : 0,
      guardUntil: R.guardUntil, gcd: R.gcd, pcd: R.pcd, hp: R.hp, mhp: R.mhp,
      e: { name: R.e.name, lv: R.e.lv, hp: R.e.hp, max: R.e.max, atk: R.e.atk, def: R.e.def, crit: R.e.crit },
      s: R.s, log: R.log, sk: R.sk, res: R.res || null
    };
  }

  // ---- старт боя: билет списывает сервер ----
  async function startInner(c, m, send) {
    const db = D(); if (!db || !c.uid) return;
    const oid = String(m.id || '');
    if (!/^[A-Za-z0-9_~-]{2,40}$/.test(oid)) return send(c, { t: 'ape', rid: 'ap', why: 'noopp' });
    const now = Date.now();
    const sref = db.collection('saves').doc(c.uid);
    const oref = db.collection('players').doc(oid);
    let out = null;
    try {
      await db.runTransaction(async tx => {
        const sn = await tx.get(sref); const S = sn.exists ? sn.data() : null;
        if (!S) { out = { why: 'nosave' }; return; }
        const on = await tx.get(oref); const O = on.exists ? on.data() : null;
        if (!O || !O.stats || oid === c.uid) { out = { why: 'noopp' }; return; }
        // билет: без него бой не начинается
        const st = ARENA.readState(S, now);
        if (st.atk < 1) { out = { why: 'noticket' }; return; }
        // списываем билет и обновляем время начисления
        st.atk -= 1;
        const ns = Object.assign({}, S, { atk: st.atk, atkt: st.atkt });
        tx.set(sref, ns);
        const h = hero(S);
        const e = {
          name: String(O.name || oid).slice(0, 20), lv: O.lvl | 0,
          hp: Math.max(1, O.stats.hp | 0), max: Math.max(1, O.stats.hp | 0),
          atk: Math.round((O.stats.atk | 0) * .9), def: O.stats.def | 0, crit: Math.min(40, O.stats.crit | 0)
        };
        const R = {
          uid: c.uid, oid, cls: String(S.cls || 'berserk'), lvl: S.lvl | 0, t0: now, clk: 0, ch: 0, ech: 0, guardUntil: 0, gcd: 0, pcd: 0,
          hp: Math.max(1, Math.min(h.mhp, S.hp || h.mhp)), mhp: h.mhp, atk: h.atk, def: h.def, crit: h.crit,
          e, st: 'on', win: 0, log: [], sk: {}, pots: Object.assign({}, S.pt || {}),
          rage: 0, weak: 0, weakv: 1, skin: 0, q: (S.skq || {}), s: { r: 0, dealt: 0, taken: 0, crit: 0, ecrit: 0, pots: 0 }
        };
        out = { R, orat: O.rating | 0, myrat: st.rt | 0, skq: S.skq || {} };
      });
    } catch (e) { console.error('apvp start', e.message); return send(c, { t: 'ape', rid: 'ap', why: 'db' }); }
    if (!out || !out.R) return send(c, { t: 'ape', rid: 'ap', why: (out && out.why) || 'no' });
    const R = out.R;
    rooms.set(c.uid, R);
    send(c, { t: 'aps', rid: 'ap', st: pub(R) });
    tick(R, c, send);
  }

  async function start(c, m, send) {
    if (!c.uid || rooms.has(c.uid) || starting.has(c.uid)) return;
    starting.add(c.uid);
    try { await startInner(c, m, send); }
    finally { starting.delete(c.uid); }
  }

  // ---- ход игрока ----
  function act(c, m, send) {
    const R = rooms.get(c.uid); if (!R || R.st !== 'on') return;
    const a = String(m.a || '');
    const now = R.clk;
    let msg = null;
    if (a === 'guard') {
      if (now < R.gcd) return send(c, { t: 'aps', rid: 'ap', st: pub(R) });
      R.guardUntil = now + 3000; R.gcd = now + 8000;
      msg = 'Ты поднимаешь щит на 3 секунды.';
    } else if (a === 'strike') {
      if (R.ch < .2) return send(c, { t: 'aps', rid: 'ap', st: pub(R) });
      const k = R.ch; R.ch = 0; R.s.r++;
      let mul = 1;
      if (R.rage) { mul *= R.rage; R.rage = 0; }
      let d = Math.max(1, Math.round((rnd(.8, 1.2) * R.atk - R.e.def * .5) * k * mul));
      const crit = Math.random() * 100 < R.crit;
      if (crit) { d = Math.round(d * 1.6); R.s.crit++; }
      R.e.hp = Math.max(0, R.e.hp - d); R.s.dealt += d;
      msg = `Ты наносишь ${d} урона${crit ? ' (крит!)' : ''}.`;
    } else if (a === 'pot') {
      const n = R.pots.b | 0;
      if (n < 1) return send(c, { t: 'aps', rid: 'ap', st: pub(R) });
      R.pots.b = n - 1; R.s.pots++;
      const h = Math.round(R.mhp * .4);
      R.hp = Math.min(R.mhp, R.hp + h);
      msg = `Бутылка: +${h} здоровья.`;
    } else if (a.startsWith('sk-')) {
      msg = skill(R, a.slice(3));
      if (msg === false) return send(c, { t: 'aps', rid: 'ap', st: pub(R) });
    } else return;
    if (msg) R.log.push(msg);
    send(c, { t: 'aps', rid: 'ap', st: pub(R) });
    if (R.e.hp <= 0) return end(R, 1, c, send);
    if (R.hp <= 0) return end(R, 0, c, send);
  }

  // ---- навыки ----
  function skill(R, id) {
    const cls = SKL[R.cls] || SKL.berserk;
    const def = cls.find(x => x[0] === id); if (!def) return false;
    // качество умения ограничиваем уровнем героя (пороги как в игре)
    const SKLV = [0, 15, 25, 35, 45];
    let q = clamp(R.q[id] | 0, 0, 4);
    while (q > 0 && (R.lvl | 0) < SKLV[q]) q--;
    const cd = Math.round(def[1] * SKCD[q] * 10) / 10 * 1000;
    if ((R.sk[id] | 0) > R.clk) return false;
    R.sk[id] = R.clk + cd;
    const v = SKQ[id][q];
    if (id === 'rage') { R.rage = v; return `Ярость! Следующий удар ×${String(v).replace('.', ',')}.`; }
    if (id === 'roar') { R.weak = R.clk + 6000; R.weakv = 1 - v / 100; return 'Боевой рёв: враг бьёт слабее.'; }
    if (id === 'skin') { R.skin = R.clk + v * 1000; return 'Каменная кожа: урон по тебе снижен.'; }
    if (id === 'totem') { const h = Math.round(R.mhp * v / 100); R.hp = Math.min(R.mhp, R.hp + h); return `Тотем исцеления: +${h} здоровья.`; }
    if (id === 'trap') { R.e.stun = R.clk + v * 1000; return `${R.e.name} попал в капкан.`; }
    if (id === 'shot') {
      let d = Math.round(R.atk * v * rnd(.9, 1.1));
      const c = Math.random() * 100 < R.crit; if (c) d = Math.round(d * 1.8);
      R.e.hp = Math.max(0, R.e.hp - d); R.s.dealt += d;
      return `${c ? 'Меткий ' : ''}Выстрел: ${d} урона.`;
    }
    return false;
  }

  // ---- ход врага ----
  function enemyTurn(R) {
    if (R.e.stun > R.clk) return;
    let d = Math.max(1, Math.round(rnd(.8, 1.2) * R.e.atk - R.def * .6));
    if (R.e.crit && Math.random() * 100 < R.e.crit) { d = Math.round(d * 1.6); R.s.ecrit++; }
    if (R.clk < R.guardUntil) d = Math.max(1, Math.round(d * .4));
    if (R.clk < R.skin) d = Math.max(1, Math.round(d * (1 - 60 / 100)));
    if (R.clk < R.weak) d = Math.max(1, Math.round(d * R.weakv));
    R.hp = Math.max(0, R.hp - d); R.s.taken += d;
    R.log.push(`${R.e.name} бьёт тебя на ${d}.`);
  }

  // ---- конец боя: рейтинг и билет начисляет сервер ----
  async function end(R, win, c, send) {
    if (R.st !== 'on') return;
    R.st = 'end'; R.win = win;
    const db = D(); if (!db) return;
    const now = Date.now();
    const sref = db.collection('saves').doc(R.uid);
    const oref = db.collection('players').doc(R.oid);
    try {
      await db.runTransaction(async tx => {
        const sn = await tx.get(sref); const S = sn.exists ? sn.data() : null;
        const on = await tx.get(oref); const O = on.exists ? on.data() : null;
        if (!S) return;
        const st = ARENA.readState(S, now);
        const orat = O ? (O.rating | 0) : 1000;
        const diff = orat - st.rt;
        let rt = 0, lost = 0;
        if (win === 1) {
          const rw = clamp(Math.round(20 + diff / 20), 8, 40);
          st.rt += rw; st.srt += rw; rt = rw;
        } else if (win === 0) {
          const rl = clamp(Math.round(12 - diff / 30), 5, 25);
          const r = Math.min(rl, st.rt);
          st.rt -= r; st.srt = Math.max(0, st.srt - rl);
          rt = -r; lost = Math.floor((S.gold | 0) * .1);
        }
        const ns = Object.assign({}, S, {
          rating: st.rt, srat: st.srt, atk: st.atk, atkt: st.atkt,
          hp: win === 1 ? S.hp : 1, gold: Math.max(0, (S.gold | 0) - lost),
          win: (S.win | 0) + (win === 1 ? 1 : 0), lose: (S.lose | 0) + (win === 0 ? 1 : 0)
        });
        tx.set(sref, ns);
        tx.set(db.collection('players').doc(R.uid), {
          rating: st.rt, srat: st.srt, win: ns.win, lose: ns.lose
        }, { merge: true });
        R.res = { rt, rating: st.rt, srt: st.srt, lost, win, atk: st.atk, atkt: st.atkt };
      });
    } catch (e) { console.error('apvp end', e.message); }
    rooms.delete(R.uid);
    send(c, { t: 'aps', rid: 'ap', st: pub(R) });
  }

  // ---- тик боя ----
  function tick(R, c, send) {
    if (!R || R.st !== 'on' || rooms.get(R.uid) !== R || !c.open) return;
    const now = Date.now();
    R.clk = now - R.t0;
    R.ch = Math.min(1, R.ch + TICK / 1000 / CH_T);
    if (R.clk >= R.ech) { R.ech += E_T * 1000; enemyTurn(R); }
    if (R.hp <= 0) return end(R, 0, c, send);
    if (R.e.hp <= 0) return end(R, 1, c, send);
    if (R.clk >= FIGHT_T) { R.log.push('Время вышло.'); return end(R, R.hp > 0 ? 1 : 0, c, send); }
    send(c, { t: 'aps', rid: 'ap', st: pub(R) });
    setTimeout(() => tick(R, c, send), TICK).unref();
  }

  function onMsg(c, m, send) {
    if (!c.uid) return;
    if (m.t === 'apvp') return start(c, m, send);
    if (m.t === 'apa') return act(c, m, send);
  }
  function onClose(c) { const R = rooms.get(c.uid); if (R) { R.st = 'closed'; rooms.delete(c.uid); } }

  return { onMsg, onClose, stats: () => ({ rooms: rooms.size }) };
};

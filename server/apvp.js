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
const CQ = require('./cq.js');

const TICK = 250;        // тик боя, мс
const CH_T = 5;          // время заряда удара, с
const E_T = 5;           // период атаки врага, с
const GRACE_MS = 25000;  // сколько бой ждёт переподключения клиента (обрыв связи на телефоне)
const FIGHT_T = 45000;   // максимум боя, мс
const LIST_N = 5, LIST_POOL = 15, REFRESH_MS = 15 * 60000, REFRESH_AU = 5;   // «Противники»: 5 из 15 ближайших по рейтингу
const BCD = 90000;       // перезарядка бутылки, мс (как на охоте)
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
    const withLog = R.lsent !== R.log.length || R.st !== 'on';
    R.lsent = R.log.length;
    return {
      pid: R.oid, st: R.st, win: R.win, clk: R.clk, ch: R.ch, ech: clamp(R.ech, 0, 1),
      guardUntil: R.guardUntil, gcd: R.gcd, pcd: R.pcd, hp: R.hp, mhp: R.mhp,
      e: { name: R.e.name, lv: R.e.lv, hp: R.e.hp, max: R.e.max, atk: R.e.atk, def: R.e.def, crit: R.e.crit, cls: R.e.cls, pet: R.e.pet || '', stun: R.e.stun | 0 },
      s: R.s, log: withLog ? R.log : undefined, sk: R.sk, ske: R.ske || null, rage: R.rage || 0, weak: R.weak | 0, skin: R.skin | 0, res: R.res || null
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
        const mn = await tx.get(db.collection('players').doc(c.uid)); const M = mn.exists ? mn.data() : null;
        if (!O || !O.stats || oid === c.uid) { out = { why: 'noopp' }; return; }
        // нападать можно только на тех, кто в списке «Противники», и не на побеждённых
        const ln = await tx.get(db.collection('arlist').doc(c.uid)); const L = ln.exists ? ln.data() : null;
        if (!L || !(L.o || []).some(x => x.id === oid)) { out = { why: 'notlist' }; return; }
        if ((L.won || []).includes(oid)) { out = { why: 'won' }; return; }
        // билет: без него бой не начинается
        const st = ARENA.readState(S, now);
        if (st.atk < 1) { out = { why: 'noticket' }; return; }
        // списываем билет и обновляем время начисления
        st.atk -= 1;
        const ns = Object.assign({}, S, { atk: st.atk, atkt: st.atkt });
        tx.set(sref, ns);
        const h = hero(S);
        // клиент считает бонусы (камни, чары, комплекты, эликсиры, постройки), сервер их не знает:
        // берём опубликованные характеристики героя, но не больше чем в 2.5 раза выше расчёта по вещам
        const ms = (M && M.stats) || null;
        if (ms) {
          const up = (v, base) => { v = v | 0; return v > 0 ? Math.min(v, Math.round(base * 2.5) + 20) : base; };
          h.atk = up(ms.atk, h.atk); h.def = up(ms.def, h.def); h.mhp = up(ms.hp, h.mhp); h.crit = Math.min(60, Math.max(h.crit, ms.crit | 0));
        }
        const e = {
          name: String(O.name || oid).slice(0, 20), lv: O.lvl | 0,
          hp: Math.max(1, O.stats.hp | 0), max: Math.max(1, O.stats.hp | 0),
          atk: Math.round((O.stats.atk | 0) * .9), def: O.stats.def | 0, crit: Math.min(40, O.stats.crit | 0),
          pet: ['wolf', 'bear', 'lynx', 'raven'].includes(O.pet) ? O.pet : '',   // питомец соперника: только для вида
          cls: ['berserk', 'hunter', 'shaman'].includes(O.cls) ? O.cls : 'berserk'   // чтобы клиент нарисовал соперника в рост по классу
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
    R.conn = { c, send };
    rooms.set(c.uid, R);
    send(c, { t: 'aps', rid: 'ap', st: pub(R) });
    tick(R);
  }

  async function start(c, m, send) {
    if (!c.uid || rooms.has(c.uid) || starting.has(c.uid)) return;
    starting.add(c.uid);
    try { await startInner(c, m, send); }
    finally { starting.delete(c.uid); }
  }

  // ---- ход игрока ----
  function act(c, m, send) {
    const R = rooms.get(c.uid);
    if (!R || R.st !== 'on') return send(c, { t: 'ape', rid: 'ap', why: 'noroom' });   // боя нет (рестарт сервера, обрыв): клиент должен выйти из боя
    if (R.conn.c !== c) R.conn = { c, send };   // клиент переподключился: бой продолжается на новом соединении
    const a = String(m.a || '');
    const now = R.clk;
    let msg = null;
    if (a === 'strike') {
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
      if (n < 1 || now < R.pcd) return send(c, { t: 'aps', rid: 'ap', st: pub(R) });   // бутылку нельзя пить одну за другой
      R.pots.b = n - 1; R.s.pots++; R.pcd = now + BCD;
      const h = R.mhp - R.hp;           // бутылка лечит полностью (энергию возвращает клиент)
      R.hp = R.mhp;
      msg = `Бутылка: здоровье и энергия восстановлены полностью${h > 0 ? ` (+${h})` : ''}.`;
    } else if (a === 'flee') {
      R.log.push('Ты сдался.');
      return end(R, 0, c, send);
    } else if (a.startsWith('sk-')) {
      msg = skill(R, a.slice(3));
      if (msg === false) return send(c, { t: 'aps', rid: 'ap', st: pub(R) });
    } else if (a === 'sync') {
      return send(c, { t: 'aps', rid: 'ap', st: pub(R) });
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
    R.ske = { id, n: ((R.ske && R.ske.n) | 0) + 1 };   // событие для анимации на клиенте
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
    let d = Math.max(1, Math.round(rnd(.8, 1.2) * R.e.atk - R.def * .6));
    if (R.e.crit && Math.random() * 100 < R.e.crit) { d = Math.round(d * 1.6); R.s.ecrit++; }
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
        const mn = await tx.get(db.collection('players').doc(R.uid)); const M = mn.exists ? mn.data() : null;
        const h1 = await tx.get(db.collection('arhist').doc(R.uid));
        const h2 = await tx.get(db.collection('arhist').doc(R.oid));
        const ln = await tx.get(db.collection('arlist').doc(R.uid)); const L = ln.exists ? ln.data() : null;
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
          hp: win === 1 ? Math.max(1, Math.min(R.mhp, R.hp | 0)) : 1, gold: Math.max(0, (S.gold | 0) - lost),
          win: (S.win | 0) + (win === 1 ? 1 : 0), lose: (S.lose | 0) + (win === 0 ? 1 : 0)
        });
        tx.set(sref, ns);
        tx.set(db.collection('players').doc(R.uid), {
          rating: st.rt, srat: st.srt, win: ns.win, lose: ns.lose
        }, { merge: true });
        if (win === 1 && L && !(L.won || []).includes(R.oid)) tx.set(db.collection('arlist').doc(R.uid), Object.assign({}, L, { won: (L.won || []).concat(R.oid) }));
        // история боёв: последние 10 как нападающий и как защитник
        const myName = String((M && M.name) || R.uid).slice(0, 20);
        const keep = (a, e) => [e].concat(Array.isArray(a) ? a : []).slice(0, 10);
        const H1 = h1.exists ? h1.data() : {}, H2 = h2.exists ? h2.data() : {};
        tx.set(db.collection('arhist').doc(R.uid), { a: keep(H1.a, { n: R.e.name, w: win, r: rt, t: now }), d: Array.isArray(H1.d) ? H1.d : [] });
        tx.set(db.collection('arhist').doc(R.oid), { a: Array.isArray(H2.a) ? H2.a : [], d: keep(H2.d, { n: myName, w: win, r: 0, t: now }) });
        R.res = { rt, rating: st.rt, srt: st.srt, lost, win, atk: st.atk, atkt: st.atkt };
      });
    } catch (e) { console.error('apvp end', e.message); }
    rooms.delete(R.uid);
    if (R.res && R.res.win === 1) CQ.add(db, R.uid, 'arena', 1);   // клановое задание «Арена клана»
    const k = R.conn || { c, send };   // итог получает тот, кто сейчас подключён
    if (k.c && k.c.open) k.send(k.c, { t: 'aps', rid: 'ap', st: pub(R) });
  }

  // ---- тик боя ----
  function tick(R) {
    if (!R || R.st !== 'on' || rooms.get(R.uid) !== R) return;
    const k = R.conn, live = !!(k && k.c.open);
    // клиент пропал (обрыв связи): бой идёт дальше и ждёт возвращения, но не дольше GRACE_MS
    if (!live) { if (!R.det) R.det = Date.now(); if (Date.now() - R.det > GRACE_MS) { R.log.push('Связь потеряна.'); return end(R, 0, k && k.c, k && k.send); } } else R.det = 0;
    const now = Date.now(), prev = R.clk;
    R.clk = now - R.t0;
    // заряды растут по реальному времени (setTimeout «уплывает», клиент считает по часам)
    const dt = Math.max(0, Math.min(1000, R.clk - prev)) / 1000;
    R.ch = Math.min(1, R.ch + dt / CH_T);
    // заряд атаки врага не растёт, пока он в капкане (как на охоте)
    if (!(R.e.stun > R.clk)) R.ech += dt / E_T;
    if (R.ech >= 1) { R.ech = 0; enemyTurn(R); }
    if (R.hp <= 0) return end(R, 0, k.c, k.send);
    if (R.e.hp <= 0) return end(R, 1, k.c, k.send);
    if (R.clk >= FIGHT_T) { R.log.push('Время вышло.'); return end(R, R.hp > 0 && R.hp / R.mhp > R.e.hp / R.e.max ? 1 : 0, k.c, k.send); }   // по времени побеждает тот, у кого больше доля здоровья
    if (live) k.send(k.c, { t: 'aps', rid: 'ap', st: pub(R) });
    setTimeout(() => tick(R), TICK).unref();
  }

  // ---- список «Противники» ----
  const listing = new Set();
  const snap = (id, p) => ({ id, name: String(p.name || id).slice(0, 20), lvl: p.lvl | 0, rating: p.rating | 0, cls: p.cls || '', av: p.av || null, stats: p.stats });
  // общий для всех кэш игроков на 60 с: читать 300 анкет из базы на каждое обновление списка слишком долго
  let PC = null;
  async function poolOf(db) {
    if (PC && PC.list && Date.now() - PC.t < 60000) return PC.list;
    if (PC && PC.p) return PC.p;
    const p = db.collection('players').limit(300).get().then(sn => {
      const list = sn.docs.filter(d => d.data().stats).map(d => { const x = d.data(); return { id: d.id, p: { name: x.name, lvl: x.lvl, rating: x.rating, cls: x.cls, av: x.av, stats: x.stats } }; });
      PC = { t: Date.now(), list }; return list;
    }).catch(e => { PC = null; throw e; });
    PC = { t: 0, p };
    return p;
  }
  async function candidates(db, uid, exclude) {
    const me = await db.collection('players').doc(uid).get(); const mr = me.exists ? (me.data().rating | 0) : 1000;
    let all = (await poolOf(db)).filter(x => x.id !== uid);
    const fresh = all.filter(x => !exclude.includes(x.id));
    if (fresh.length >= LIST_N) all = fresh;
    all.sort((a, b) => Math.abs((a.p.rating | 0) - mr) - Math.abs((b.p.rating | 0) - mr));
    const pool = all.slice(0, LIST_POOL);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    return pool.slice(0, LIST_N).map(x => snap(x.id, x.p));
  }
  async function listMsg(c, m, send) {
    const db = D(); if (!db || !c.uid || listing.has(c.uid)) return;
    listing.add(c.uid);
    try {
      const now = Date.now(), uid = c.uid, ref = db.collection('arlist').doc(uid), wref = db.collection('wallet').doc(uid);
      const pre = await ref.get(); const P = pre.exists ? pre.data() : { o: [], won: [], t: 0 };
      const manual = m.t === 'arr', allWon = (P.o || []).length && P.o.every(x => (P.won || []).includes(x.id));
      let out = null;
      if (manual || !(P.o || []).length || allWon) {
        const cand = await candidates(db, uid, (P.o || []).map(x => x.id));
        await db.runTransaction(async tx => {
          const sn = await tx.get(ref); const L = sn.exists ? sn.data() : { o: [], won: [], t: 0 };
          const ws = await tx.get(wref);
          const aw = (L.o || []).length && L.o.every(x => (L.won || []).includes(x.id));
          let t = +L.t || 0, au = null;
          if (manual) {
            if (now - t < REFRESH_MS) {
              if (!m.pay) { out = { why: 'cd', lt: t }; return; }
              if (!ws.exists || (ws.data().au | 0) < REFRESH_AU) { out = { why: 'nogold', lt: t }; return; }
              au = (ws.data().au | 0) - REFRESH_AU;
              tx.update(wref, { au }); tx.set(wref.collection('log').doc(now.toString(36) + 'r'), { op: 'pay', n: -REFRESH_AU, why: 'arl', ts: now });
            }
            t = now;
          } else if ((L.o || []).length && !aw) { out = { o: L.o, won: L.won || [], lt: t, au }; return; }   // кто-то успел обновить раньше
          if (!cand.length) { out = { o: [], won: [], lt: t, au }; return; }
          const nl = { o: cand, won: [], t };
          tx.set(ref, nl); out = { o: nl.o, won: [], lt: t, au };
        });
      } else out = { o: P.o, won: P.won || [], lt: +P.t || 0 };
      send(c, Object.assign({ t: 'arl', now: Date.now(), cd: REFRESH_MS, price: REFRESH_AU }, out || { why: 'db' }));
    } catch (e) { console.error('apvp list', e.message); send(c, { t: 'arl', why: 'db' }); }
    finally { listing.delete(c.uid); }
  }

  function onMsg(c, m, send) {
    if (!c.uid) return;
    if (m.t === 'arl' || m.t === 'arr') return listMsg(c, m, send);
    if (m.t === 'apvp') return start(c, m, send);
    if (m.t === 'apa') return act(c, m, send);
  }
  // обрыв связи посреди боя: бой не бросаем, ждём переподключения (GRACE_MS), потом поражение
  function onClose(c) { const R = rooms.get(c.uid); if (R && R.st !== 'on') { R.st = 'closed'; rooms.delete(c.uid); } }

  return { onMsg, onClose, stats: () => ({ rooms: rooms.size }) };
};

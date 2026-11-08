// Рейды на сервере: общий босс живёт в памяти сервера.
// Игроки шлют по сокету накопленный урон и своё продвижение (волна, у босса, пал),
// сервер считает здоровье босса, бьёт за наёмников, следит за временем и рассылает состояние всей группе.
// В Firestore рейд записывается только раз в 30 секунд (на случай перезапуска) и в конце — раньше это были сотни записей.
'use strict';
const RN = [['🐻', 'Медведь-шатун'], ['💀', 'Конунг драугров'], ['🪨', 'Горный тролль'], ['🐍', 'Ледяной змей'], ['🔥', 'Сурт Огненный']];
const RBOTK = 0.18;          // наёмник наносит ~18% атаки в секунду (как в клиенте)
const PERSIST = 30000, TICK = 1000, CAST = 250;
// общие волны: все игроки группы бьют одних и тех же слуг (здоровье — на сервере)
const RWV = 3, RWN = 4, RLV = [10, 20, 30, 45, 60];
const RMOB = [['Лесной волк', 'Дикий кабан', 'Вожак стаи'], ['Драугр', 'Болотная крыса', 'Разбойник с тракта'], ['Тролль-подросток', 'Снежный барс', 'Горный медведь'], ['Снежный барс', 'Драугр', 'Тролль-подросток'], ['Драугр', 'Тролль-подросток', 'Вожак стаи']];
const humans = R => Object.values(R.mem).filter(x => !x.bot);
// опыт до следующего уровня — та же формула, что в игре
const xpNeed = L => { const m = L <= 10 ? .3 : Math.min(1, .3 + .07 * (L - 10)); return Math.round((20 * L * L + .8 * L * L * L) * m); };
function spawn(R, n) {
  R.mobs = [];
  if (n > RWV) { R.wv = RWV + 1; if (!R.bon) R.bon = Date.now(); for (const m of Object.values(R.mem)) m.wv = RWV; return; }
  R.wv = n;
  const H = humans(R), alive = H.filter(x => !x.dead).length || 1;
  const lv = Math.max(RLV[R.b] || 10, Math.round(H.reduce((s, x) => s + (x.lv | 0), 0) / (H.length || 1)));
  const k = 0.45 + 0.05 * n + 0.03 * R.b, cnt = RWN + (n === RWV ? 1 : 0), mul = Math.max(1, 0.8 * alive), L = RMOB[R.b] || RMOB[0];
  for (let i = 0; i < cnt; i++) {
    const ld = n === RWV && i === cnt - 1 ? 1 : 0;
    const max = Math.round((28 + lv * 13 * k) * mul * (ld ? 1.8 : 1));
    R.mobs.push({ n: L[(i + n) % L.length], lv, k, ld, hp: max, max });
  }
  for (const m of Object.values(R.mem)) m.wv = Math.max(m.wv | 0, n - 1);
}
function waveDone(R) { return R.sw && R.wv <= RWV && R.mobs && R.mobs.length && R.mobs.every(m => m.hp <= 0); }
const rnd = (a, b) => a + Math.random() * (b - a);

module.exports = function raids(getDb) {
  const rooms = new Map(); // rid → {R, subs:Set, dirty, last, saved, loading}

  function L0(R, t) { R.log = [t, ...(R.log || [])].slice(0, 14); }
  function pub(R) { return { b: R.b, w: R.w, st: R.st, hp: R.hp, max: R.max, dl: R.dl, bon: R.bon || 0, mem: R.mem, log: R.log, sw: R.sw || 0, wv: R.wv || 0, mobs: R.mobs || [], go: R.go || 0 }; }

  async function load(rid) {
    let r = rooms.get(rid);
    if (r) { if (r.loading) await r.loading; return rooms.get(rid); }
    const db = getDb(); if (!db) return null;
    r = { R: null, subs: new Set(), dirty: false, last: 0, saved: Date.now() };
    rooms.set(rid, r);
    r.loading = db.collection('raids').doc(rid).get().then(sn => { r.R = sn.exists ? sn.data() : null; }).catch(() => { r.R = null; });
    await r.loading; r.loading = null;
    if (!r.R || !r.R.w) { rooms.delete(rid); return null; } // только новые рейды с волнами
    const R = r.R;
    if (!R.mem || typeof R.mem !== 'object') { rooms.delete(rid); return null; } // битый документ — не грузим
    // свежий рейд (никто ещё не продвинулся) — включаем общие волны
    if (R.sw == null && R.st === 'on' && !Object.values(R.mem).some(x => !x.bot && ((x.wv | 0) > 0 || x.bs || (x.dealt | 0) > 0))) { R.sw = 1; spawn(R, 1); L0(R, `Волна 1 из ${RWV}: бейте слуг всей группой!`); }
    return r;
  }

  // запись в Firestore: аккуратно сливаем с тем, что там есть (на случай игроков без сокета)
  async function persist(rid, r) {
    const db = getDb(); if (!db || !r.R) return;
    r.saved = Date.now();
    const ref = db.collection('raids').doc(rid);
    try {
      await db.runTransaction(async tx => {
        const sn = await tx.get(ref); if (!sn.exists) return;
        const D = sn.data(), R = r.R;
        D.hp = Math.min(D.hp, R.hp);
        for (const [id, m] of Object.entries(R.mem)) {
          const x = D.mem[id]; if (!x) continue;
          x.dealt = Math.max(x.dealt | 0, m.dealt | 0); x.wv = Math.max(x.wv | 0, m.wv | 0);
          x.bs = Math.max(x.bs | 0, m.bs | 0); x.dead = Math.max(x.dead | 0, m.dead | 0);
        }
        if (R.bon && !D.bon) D.bon = R.bon;
        if (R.sw) { D.sw = 1; D.wv = R.wv; D.mobs = R.mobs; D.go = R.go || 0; }
        if (D.st === 'on' && R.st !== 'on') D.st = R.st;
        if (D.st !== 'on' && R.st === 'on') R.st = D.st;           // кто-то без сокета уже закончил рейд
        if (D.hp <= 0 && D.st === 'on') D.st = 'win';
        D.log = R.log;
        // награда за рейд: сервер сам решил, что босс повержен (finish()).
        // Клиент больше не начисляет награду сам — иначе можно было бы записать
        // в документ рейда st:'win' и забрать добычу.
        if (R.st === 'win' && !D.awarded) {
          D.awarded = 1;
          const t = R.b | 0;
          const hum = Object.values(R.mem).filter(x => !x.bot).length;
          const mf = hum < 5 ? .7 : 1;
          const g = Math.round([150, 400, 900, 1800, 3500][t] * mf);
          const ir = Math.round([20, 40, 70, 110, 160][t] * mf);
          const du = Math.round([3, 6, 10, 15, 25][t] * mf);
          for (const [id, x] of Object.entries(R.mem)) {
            if (x.bot) continue;
            const sref = db.collection('saves').doc(id);
            const sn = await tx.get(sref); const S = sn.exists ? sn.data() : null;
            if (!S) continue;
            const xp = Math.round(xpNeed(S.lvl | 0) * [.25, .25, .3, .3, .35][t] * mf);
            const aw = Object.assign({}, S._aw || {}, {
              g: (S._aw && S._aw.g || 0) + g, i: (S._aw && S._aw.i || 0) + ir,
              d: (S._aw && S._aw.d || 0) + du, x: (S._aw && S._aw.x || 0) + xp
            });
            tx.set(sref, Object.assign({}, S, { _aw: aw }));
          }
        }
        tx.set(ref, D);
        R.hp = D.hp; R.st = D.st;
        for (const [id, x] of Object.entries(D.mem)) if (R.mem[id]) Object.assign(R.mem[id], { dealt: x.dealt, wv: x.wv, bs: x.bs, dead: x.dead });
      });
    } catch (e) { console.error('raid persist', rid, e.message); }
  }

  function nextWave(R) {
    const n = (R.wv | 0) + 1;
    spawn(R, n);
    L0(R, n > RWV ? `${RN[R.b][0]} ${RN[R.b][1]} выходит на группу! Бейте вместе.` : `Волна ${n} из ${RWV}!`);
  }
  function finish(R) {
    if (R.st !== 'on') return;
    if (R.hp <= 0) { R.st = 'win'; L0(R, `${RN[R.b][0]} ${RN[R.b][1]} повержен! Победа!`); }
    else if (Object.values(R.mem).filter(x => !x.bot).every(x => x.dead)) { R.st = 'lose'; L0(R, 'Вся группа пала. Поражение.'); }
    else if (Date.now() > R.dl + 2000) { R.st = 'lose'; L0(R, `Время вышло: ${RN[R.b][1]} уходит в глубину. Поражение.`); }
  }

  function cast(rid, r, send, force) {
    const now = Date.now();
    if (!force && now - r.last < CAST) { r.dirty = true; if (!r.tm) r.tm = setTimeout(() => { r.tm = null; if (r.dirty) cast(rid, r, send, true); }, CAST - (now - r.last) + 5); return; }
    r.last = now; r.dirty = false;
    const msg = { t: 'rs', rid, r: pub(r.R) };
    for (const c of r.subs) send(c, msg);
  }

  // раз в секунду: наёмники бьют босса, проверка времени, рассылка, сохранение
  setInterval(() => {
    const now = Date.now();
    for (const [rid, r] of rooms) {
      // одна сломанная комната не должна ронять весь сервер
      try {
        const R = r.R; if (!R) continue;
        if (R.st === 'on') {
          if (R.sw && R.go && R.wv <= RWV && R.mobs) {
            for (const b of Object.values(R.mem)) if (b.bot && !b.dead) {
              const L = R.mobs.filter(m => m.hp > 0); if (!L.length) break;
              const m = L[Math.floor(Math.random() * L.length)], d = Math.round(b.atk * RBOTK * rnd(0.8, 1.2));
              m.hp = Math.max(0, m.hp - d); r.dirty = true;
            }
            if (waveDone(R)) nextWave(R);
          }
          if (R.bon) {
            for (const b of Object.values(R.mem)) if (b.bot && !b.dead && R.hp > 0) {
              const d = Math.round(b.atk * RBOTK * rnd(0.8, 1.2)); R.hp = Math.max(0, R.hp - d); b.dealt = (b.dealt | 0) + d; r.dirty = true;
            }
          }
          const st0 = R.st; finish(R);
          if (R.st !== st0) { cast(rid, r, r.send, true); persist(rid, r); continue; }
          if (now - r.saved > PERSIST) persist(rid, r);
        }
        if (r.dirty) cast(rid, r, r.send, true);
        // рейд закончился и все ушли — убираем из памяти
        if ((R.st !== 'on' && now - r.saved > 60000) || (!r.subs.size && now - r.saved > 10 * 60000)) { if (R.st === 'on') persist(rid, r); rooms.delete(rid); }
      } catch (e) { console.error('raid tick', rid, e && e.message); }
    }
  }, TICK).unref();

  // сообщения от игрока (c.uid уже проверен хабом по токену Firebase)
  async function onMsg(c, m, send) {
    if (!c.uid || typeof m.rid !== 'string' || !/^[A-Za-z0-9_-]{4,40}$/.test(m.rid)) return;
    const rid = m.rid;
    if (m.t === 'rj') {
      const r = await load(rid);
      if (!r || !r.R || !r.R.mem[c.uid]) return send(c, { t: 'rno', rid });
      r.send = send; r.subs.add(c); (c.rooms = c.rooms || new Set()).add(rid);
      return send(c, { t: 'rs', rid, r: pub(r.R) });
    }
    const r = rooms.get(rid); if (!r || !r.R || !r.subs.has(c)) return;
    const R = r.R, me = R.mem[c.uid]; if (!me || R.st !== 'on') return;
    if (m.t === 'rd') { // урон по боссу
      if (me.dead || !me.bs) return;
      const now = Date.now(), dt = Math.min(10, Math.max(0.25, (now - (me._t || now - 1000)) / 1000)); me._t = now;
      // защита от подделки: не больше разумного урона за прошедшее время
      const cap = Math.max(R.max * 0.02, (me.atk || 100) * 12) * dt;
      const d = Math.max(0, Math.min(Math.round(+m.d || 0), cap));
      if (!d) return;
      R.hp = Math.max(0, R.hp - d); me.dealt = (me.dealt | 0) + d;
      finish(R); cast(rid, r, send, R.st !== 'on');
      if (R.st !== 'on') persist(rid, r);
      return;
    }
    if (m.t === 'rh') { // удар по слуге общей волны
      if (!R.sw || me.dead || +m.w !== R.wv || !R.mobs) return;
      const mob = R.mobs[+m.i | 0]; if (!mob || mob.hp <= 0) { if (m.q) me.q = Math.max(me.q | 0, +m.q | 0); return cast(rid, r, send); }
      const now = Date.now(), dt = Math.min(10, Math.max(0.25, (now - (me._h || now - 1000)) / 1000)); me._h = now;
      const cap = Math.max((me.atk || 100) * 8, (me.atk || 100) * 12 * dt, mob.max * 0.05);
      const d = Math.max(0, Math.min(Math.round(+m.d || 0), cap));
      mob.hp = Math.max(0, mob.hp - d); me.wd = (me.wd | 0) + d;
      if (m.q) me.q = Math.max(me.q | 0, +m.q | 0);
      if (waveDone(R)) { nextWave(R); return cast(rid, r, send, true); }
      return cast(rid, r, send);
    }
    if (m.t === 'rm') { // продвижение: волна, дошёл до босса, пал
      if (m.go && !me.go) { me.go = 1; if (!R.go) R.go = Date.now(); }
      if (Number.isFinite(+m.wv)) me.wv = Math.max(me.wv | 0, Math.min(3, +m.wv | 0));
      if (m.bs) { me.bs = 1; if (!R.bon) { R.bon = Date.now(); } }
      if (m.dead && !me.dead) { me.dead = 1; L0(R, `${me.n} пал в бою.`); }
      finish(R); cast(rid, r, send, true);
      if (R.st !== 'on') persist(rid, r);
    }
  }
  function onClose(c) { if (c.rooms) for (const rid of c.rooms) { const r = rooms.get(rid); if (r) r.subs.delete(c); } }
  return { onMsg, onClose, stats: () => [...rooms].map(([k, r]) => ({ rid: k, st: r.R && r.R.st, hp: r.R && r.R.hp, subs: r.subs.size })) };
};

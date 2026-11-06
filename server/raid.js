// Рейды на сервере: общий босс живёт в памяти сервера.
// Игроки шлют по сокету накопленный урон и своё продвижение (волна, у босса, пал),
// сервер считает здоровье босса, бьёт за наёмников, следит за временем и рассылает состояние всей группе.
// В Firestore рейд записывается только раз в 30 секунд (на случай перезапуска) и в конце — раньше это были сотни записей.
'use strict';
const RN = [['🐻', 'Медведь-шатун'], ['💀', 'Конунг драугров'], ['🪨', 'Горный тролль'], ['🐍', 'Ледяной змей'], ['🔥', 'Сурт Огненный']];
const RBOTK = 0.18;          // наёмник наносит ~18% атаки в секунду (как в клиенте)
const PERSIST = 30000, TICK = 1000, CAST = 250;
const rnd = (a, b) => a + Math.random() * (b - a);

module.exports = function raids(getDb) {
  const rooms = new Map(); // rid → {R, subs:Set, dirty, last, saved, loading}

  function L0(R, t) { R.log = [t, ...(R.log || [])].slice(0, 14); }
  function pub(R) { return { b: R.b, w: R.w, st: R.st, hp: R.hp, max: R.max, dl: R.dl, bon: R.bon || 0, mem: R.mem, log: R.log }; }

  async function load(rid) {
    let r = rooms.get(rid);
    if (r) { if (r.loading) await r.loading; return rooms.get(rid); }
    const db = getDb(); if (!db) return null;
    r = { R: null, subs: new Set(), dirty: false, last: 0, saved: Date.now() };
    rooms.set(rid, r);
    r.loading = db.collection('raids').doc(rid).get().then(sn => { r.R = sn.exists ? sn.data() : null; }).catch(() => { r.R = null; });
    await r.loading; r.loading = null;
    if (!r.R || !r.R.w) { rooms.delete(rid); return null; } // только новые рейды с волнами
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
        if (D.st === 'on' && R.st !== 'on') D.st = R.st;
        if (D.st !== 'on' && R.st === 'on') R.st = D.st;           // кто-то без сокета уже закончил рейд
        if (D.hp <= 0 && D.st === 'on') D.st = 'win';
        D.log = R.log;
        tx.set(ref, D);
        R.hp = D.hp; R.st = D.st;
        for (const [id, x] of Object.entries(D.mem)) if (R.mem[id]) Object.assign(R.mem[id], { dealt: x.dealt, wv: x.wv, bs: x.bs, dead: x.dead });
      });
    } catch (e) { console.error('raid persist', rid, e.message); }
  }

  function finish(R) {
    if (R.st !== 'on') return;
    if (R.hp <= 0) { R.st = 'win'; L0(R, `${RN[R.b][0]} ${RN[R.b][1]} повержен! Победа!`); }
    else if (Object.values(R.mem).filter(x => !x.bot).every(x => x.dead)) { R.st = 'lose'; L0(R, 'Вся группа пала. Поражение.'); }
    else if (Date.now() > R.dl + 2000) { R.st = 'lose'; L0(R, `Время вышло: ${RN[R.b][1]} уходит в глубину. Поражение.`); }
  }

  function cast(rid, r, send, force) {
    const now = Date.now();
    if (!force && now - r.last < CAST) { r.dirty = true; return; }
    r.last = now; r.dirty = false;
    const msg = { t: 'rs', rid, r: pub(r.R) };
    for (const c of r.subs) send(c, msg);
  }

  // раз в секунду: наёмники бьют босса, проверка времени, рассылка, сохранение
  setInterval(() => {
    const now = Date.now();
    for (const [rid, r] of rooms) {
      const R = r.R; if (!R) continue;
      if (R.st === 'on') {
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
    if (m.t === 'rm') { // продвижение: волна, дошёл до босса, пал
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

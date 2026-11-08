// Лайв-арена на сервере: ходы приходят по сокету, раунд считается сразу, как только оба выбрали ход
// (или по истечении 15 секунд). Логика раунда — та же, что в игре (dRound).
// Каждый раунд записывается в Firestore одной транзакцией: так игроки без сокета тоже видят дуэль.
'use strict';
const DTURN = 15000, DMAXR = 15;
const DSK = { berserk: 'Ярость', hunter: 'Меткий выстрел', shaman: 'Исцеление духов' };
const rnd = (a, b) => a + Math.random() * (b - a);

function dRound(R, acts) {
  const ids = Object.keys(R.mem).sort((a, b) => R.mem[a].o - R.mem[b].o), L = [], A = {}, dmg = {}, heal = {};
  for (const id of ids) {
    const m = R.mem[id]; let a = acts[id];
    if (m.stun >= R.r) a = 'stun'; else if (!a) { a = 'atk'; m.miss = (m.miss | 0) + 1; } else m.miss = 0;
    if (a === 'pow' && m.pcd > R.r) a = 'atk'; if (a === 'sk' && m.scd > R.r) a = 'atk'; if (a === 'pot' && !m.pot) a = 'atk';
    A[id] = a;
  }
  for (const id of ids) {
    const oid = ids.find(x => x !== id), m = R.mem[id], o = R.mem[oid], a = A[id], oa = A[oid];
    if (a === 'stun') { L.push(`${m.n} оглушён и пропускает ход.`); continue; }
    if (a === 'def') { L.push(`${m.n} поднимает щит.`); continue; }
    if (a === 'pot') { const h = Math.round(m.max * .35); heal[id] = (heal[id] | 0) + h; m.pot = 0; L.push(`${m.n} пьёт бутылку: +${h} здоровья.`); continue; }
    let k = 1, ign = false, fc = false; if (a === 'pow') { k = 2; m.pcd = R.r + 3; }
    if (a === 'sk') {
      m.scd = R.r + 4;
      if (m.cls === 'berserk') { k = 1.6; ign = true; } else if (m.cls === 'hunter') { k = 1.3; fc = true; }
      else { k = .5; const h = Math.round(m.max * .25); heal[id] = (heal[id] | 0) + h; L.push(`${m.n}: «Исцеление духов» +${h} здоровья.`); }
    }
    let d = Math.max(m.atk * .25, rnd(.85, 1.15) * m.atk - o.def * .5) * k; const c = fc || Math.random() * 100 < m.crit; if (c) d *= 1.6;
    if (oa === 'def' && !ign) { d *= .5; if (a === 'pow') { m.stun = R.r + 1; L.push(`${o.n} принимает мощный удар на щит — ${m.n} оглушён!`); } }
    d = Math.max(1, Math.round(d)); dmg[oid] = (dmg[oid] | 0) + d;
    L.push(`${m.n}: ${a === 'pow' ? 'мощный удар' : a === 'sk' ? '«' + (DSK[m.cls] || DSK.berserk) + '»' : 'удар'} — ${d}${c ? ' (крит!)' : ''}${oa === 'def' && !ign ? ' (в щит)' : ''}.`);
  }
  for (const id of ids) { const m = R.mem[id]; m.hp = Math.max(0, Math.min(m.max, m.hp + (heal[id] | 0) - (dmg[id] | 0))); }
  const [x, y] = ids.map(i => R.mem[i]); let win = null;
  if (x.miss >= 3 && y.miss < 3) win = ids[1]; else if (y.miss >= 3 && x.miss < 3) win = ids[0];
  else if (x.hp <= 0 || y.hp <= 0) win = x.hp <= 0 && y.hp <= 0 ? 'draw' : x.hp <= 0 ? ids[1] : ids[0];
  else if (R.r >= DMAXR) { const px = x.hp / x.max, py = y.hp / y.max; win = Math.abs(px - py) < .005 ? 'draw' : px > py ? ids[0] : ids[1]; L.push('Время вышло — побеждает тот, у кого больше здоровья.'); }
  if (win) { R.st = 'end'; R.win = win; L.push(win === 'draw' ? 'Ничья!' : `🏆 Победа: ${R.mem[win].n}!`); }
  else { R.r++; R.dl = Date.now() + DTURN; }
  R.log = [...L.reverse(), ...(R.log || [])].slice(0, 40);
}

module.exports = function duels(getDb) {
  const rooms = new Map(); // rid → {R, acts:{uid:{r,a}}, subs:Set, busy, send}
  const ARENA = require('./arena');
  const CYCLE = require('./cycle');

  function pub(r) { const acted = {}; for (const [id, x] of Object.entries(r.acts)) if (x.r === r.R.r) acted[id] = 1; return { R: r.R, acted }; }
  function cast(rid, r) { const m = { t: 'ds', rid, ...pub(r) }; for (const c of r.subs) r.send(c, m); }

  async function load(rid) {
    let r = rooms.get(rid); if (r) { if (r.loading) await r.loading; return rooms.get(rid); }
    const db = getDb(); if (!db) return null;
    r = { R: null, acts: {}, subs: new Set(), busy: false, t: Date.now() }; rooms.set(rid, r);
    r.loading = db.collection('raids').doc(rid).get().then(sn => { r.R = sn.exists ? sn.data() : null; }).catch(() => {});
    await r.loading; r.loading = null;
    if (!r.R || r.R.type !== 'duel') { rooms.delete(rid); return null; }
    return r;
  }

  // раунд: в транзакции, чтобы учесть и ходы игроков без сокета (raids/{id}/a/{uid})
  async function resolve(rid, r) {
    if (r.busy || !r.R || r.R.st !== 'on') return; r.busy = true;
    const db = getDb(), ref = db.collection('raids').doc(rid);
    try {
      await db.runTransaction(async tx => {
        const sn = await tx.get(ref); if (!sn.exists) return;
        const D = sn.data(); if (D.st !== 'on') { r.R = D; return; }
        if (D.r > r.R.r) { r.R = D; return; } // раунд уже посчитал кто-то другой
        const acts = {};
        for (const id of Object.keys(D.mem)) {
          const x = r.acts[id]; if (x && x.r === D.r) { acts[id] = x.a; continue; }
          const a = await tx.get(ref.collection('a').doc(id)); if (a.exists && a.data().r === D.r) acts[id] = a.data().a;
        }
        const need = Object.keys(D.mem).filter(id => D.mem[id].stun < D.r);
        if (Date.now() < D.dl && need.some(id => !acts[id])) { r.R = D; return; }
        dRound(D, acts);
        // Дневной рейтинг лайв-арены считает сервер: результат боя известен
        // только здесь, клиенту доверять нельзя.
        if (D.st === 'end' && !D.scored) await scoreDuel(tx, D);
        tx.set(ref, D); r.R = D;
      });
    } catch (e) { console.error('duel resolve', rid, e.message); }
    r.busy = false; r.t = Date.now();
    cast(rid, r);
  }

  setInterval(() => {
    const now = Date.now();
    for (const [rid, r] of rooms) {
      if (!r.R) continue;
      if (r.R.st === 'on' && now > r.R.dl) resolve(rid, r);
      if ((r.R.st !== 'on' && now - r.t > 60000) || (!r.subs.size && now - r.t > 5 * 60000)) rooms.delete(rid);
    }
  }, 500).unref();

  // Начисление дневного рейтинга обоим участникам и запись в их сохранения.
  async function scoreDuel(tx, D) {
    const db = getDb(), now = Date.now();
    const ids = Object.keys(D.mem || {});
    if (ids.length !== 2) { D.scored = 1; return; }
    const prev = {};
    for (const id of ids) {
      const sn = await tx.get(db.collection('saves').doc(id));
      prev[id] = sn.exists ? sn.data() : null;
    }
    const res = ARENA.scoreDuel(D.mem, D.win, prev, now);
    if (res) {
      for (const id of ids) {
        const r = res[id];
        const s = Object.assign({}, prev[id] || {}, {
          dr: r.dr, dn: r.dn, dw: r.dw,
          rating: r.rt, srat: r.srt, atk: r.atk,          // рейтинг и билет — сервер
          _ar: { d: ARENA.dayNum(now) }
        });
        if (r.war) s.wp = (s.wp | 0) + r.war;              // очки клановой войны
        tx.set(db.collection('saves').doc(id), s);
        tx.set(db.collection('players').doc(id), {
          dr: r.dr, dn: r.dn, dw: r.dw, rating: r.rt, srat: r.srat,
          ...(r.war ? { wp: ((prev[id] && prev[id].wp) | 0) + r.war } : {})
        }, { merge: true });
        // очки войны идут в документ войны — их тоже считает сервер
        if (r.war) await CYCLE.warPoints(tx, db, (prev[id] && prev[id].clan) || '', r.war);
      }
      D.res = res;
    }
    D.scored = 1;
  }
  async function onMsg(c, m, send) {
    if (!c.uid || typeof m.rid !== 'string' || !/^[A-Za-z0-9_-]{4,40}$/.test(m.rid)) return;
    const rid = m.rid;
    if (m.t === 'dj') {
      const r = await load(rid);
      if (!r || !r.R.mem[c.uid]) return send(c, { t: 'dno', rid });
      r.send = send; r.subs.add(c); (c.duels = c.duels || new Set()).add(rid);
      return send(c, { t: 'ds', rid, ...pub(r) });
    }
    if (m.t === 'da') {
      const r = rooms.get(rid); if (!r || !r.R || !r.subs.has(c) || r.R.st !== 'on') return;
      const R = r.R, me = R.mem[c.uid], a = String(m.a || '');
      if (!me || me.hp <= 0 || me.stun >= R.r || !['atk', 'pow', 'def', 'sk', 'pot'].includes(a)) return;
      if ((r.acts[c.uid] || {}).r === R.r) return;
      if ((a === 'pow' && me.pcd > R.r) || (a === 'sk' && me.scd > R.r) || (a === 'pot' && !me.pot)) return;
      r.acts[c.uid] = { r: R.r, a };
      const need = Object.keys(R.mem).filter(id => R.mem[id].stun < R.r);
      if (need.every(id => (r.acts[id] || {}).r === R.r)) resolve(rid, r); else cast(rid, r);
    }
  }
  function onClose(c) { if (c.duels) for (const rid of c.duels) { const r = rooms.get(rid); if (r) r.subs.delete(c); } }
  return { onMsg, onClose, stats: () => [...rooms].map(([k, r]) => ({ rid: k, st: r.R && r.R.st, r: r.R && r.R.r, subs: r.subs.size })) };
};

// dRound — чистая функция раунда, её удобно тестировать отдельно
module.exports.dRound = dRound;

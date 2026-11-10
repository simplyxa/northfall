// Клановые задания «с доски»: общие для клана, берёт любой участник.
//
// У клана одна доска. Каждое задание в один момент занимает один игрок: рядом видно, кто
// им занят, и другие его взять не могут. На выполнение 24 часа; после выполнения задание
// 24 часа «остывает» и потом снова доступно. Не успел за 24 часа — задание освобождается,
// но этому игроку оно недоступно ещё 24 часа. Одновременно у игрока не больше двух заданий.
//
// Всё считает сервер: события охоты, рейдов, арены, подземелья, босса и вкладов он видит
// сам и вызывает add(). Состояние лежит в документе клана (поле cq) — клиент его только
// читает (запись закрыта правилами).
'use strict';

const DAY = 86400000, MAX_ACTIVE = 2;

// ev — какое событие двигает задание; t(L) — цель; x/g/i — награда клану (опыт, серебро и железо в казну),
// me — награда игроку (серебро/железо). Всё умножается на f(L) = 0.5 + 0.5·L, кроме целей, у которых своя формула.
const QUESTS = {
  hunt:  { ev: 'kill',  n: 'Охота на зверей',      d: 'Убить {t} монстров на охоте',               t: L => 120 + 20 * L,  x: 400, g: 150, i: 0,  me: { g: 300, i: 0 } },
  smash: { ev: 'dmg',   n: 'Разрушитель',          d: 'Нанести {t} урона на охоте',                t: L => 40000 * L,     x: 500, g: 200, i: 0,  me: { g: 350, i: 0 } },
  raid:  { ev: 'raid',  n: 'Рейдовый воин',        d: 'Победить в {t} рейде',                      t: () => 1,            x: 800, g: 0,   i: 8,  me: { g: 600, i: 0 } },
  arena: { ev: 'arena', n: 'Арена клана',          d: 'Выиграть {t} боя на арене',                 t: () => 3,            x: 500, g: 150, i: 0,  me: { g: 400, i: 0 } },
  dun:   { ev: 'dun',   n: 'Покоритель подземелья', d: 'Пройти клановое подземелье {t} раза',       t: () => 2,            x: 600, g: 0,   i: 10, me: { g: 300, i: 5 } },
  boss:  { ev: 'wb',    n: 'Охотник на босса',     d: 'Нанести мировому боссу {t} урона',          t: () => 20000,        x: 600, g: 200, i: 0,  me: { g: 500, i: 0 } },
  gift:  { ev: 'dep',   n: 'Щедрая рука',          d: 'Внести в казну {t} серебра',                t: () => 1000,         x: 300, g: 0,   i: 0,  me: { g: 100, i: 0 } },
  craft: { ev: 'craft', n: 'Мастер-ремесленник', d: 'Закончить {t} крафта', t: () => 2, x: 400, g: 150, i: 0, me: { g: 300, i: 0 } },
  pet:   { ev: 'pet',   n: 'Верный друг',          d: 'Убить {t} монстров с активным питомцем',    t: () => 80,           x: 300, g: 0,   i: 0,  me: { g: 250, i: 0 } },
};

const f = L => 0.5 + 0.5 * L;
const rewardOf = (key, L) => { const Q = QUESTS[key]; return { x: Math.round(Q.x * f(L)), g: Math.round(Q.g * f(L)), i: Math.round(Q.i * f(L)), mg: Math.round(Q.me.g * f(L)), mi: Math.round(Q.me.i * f(L)) }; };

// состояние задания: free | on | done (на откате)
function status(q, now) {
  if (!q) return 'free';
  if (q.done) return now < (+q.cd || 0) ? 'done' : 'free';
  if (q.u && now < (+q.t || 0) + DAY) return 'on';
  return 'free';
}
const activeOf = (cq, uid, now) => Object.keys(cq || {}).filter(k => QUESTS[k] && status(cq[k], now) === 'on' && cq[k].u === uid).length;

// взять задание (вызывается внутри транзакции после чтения клана); вернёт {cq} или {err}
function take(C, uid, name, key, L, now) {
  const Q = QUESTS[key]; if (!Q) return { err: 'no' };
  const cq = Object.assign({}, C.cq || {}), q = cq[key];
  if (status(q, now) !== 'free') return { err: 'busy' };
  const ban = Object.assign({}, (q && q.ban) || {});
  // просроченное, но не выполненное задание: прежнему исполнителю запрет на ещё 24 часа после срока
  if (q && !q.done && q.u) ban[q.u] = Math.max(+ban[q.u] || 0, (+q.t || 0) + 2 * DAY);
  for (const u in ban) if (ban[u] <= now) delete ban[u];
  if ((+ban[uid] || 0) > now) return { err: 'ban', until: ban[uid] };
  if (activeOf(cq, uid, now) >= MAX_ACTIVE) return { err: 'limit' };
  cq[key] = { u: uid, n: String(name || '').slice(0, 20), t: now, p: 0, tg: Q.t(L), L, ban };
  return { cq };
}
// отказаться от своего задания: освобождается сразу, но брать его снова нельзя 24 часа
function drop(C, uid, key, now) {
  const cq = Object.assign({}, C.cq || {}), q = cq[key];
  if (!q || q.done || q.u !== uid || status(q, now) !== 'on') return { err: 'no' };
  const ban = Object.assign({}, q.ban || {}); ban[uid] = now + DAY;
  cq[key] = { ban };
  return { cq };
}

// событие игрока: двигает его активные задания и сразу выдаёт награду при выполнении
async function add(dbx, uid, ev, n) {
  n = Math.floor(+n || 0); if (!(n > 0) || !dbx || !uid) return;
  try {
    await dbx.runTransaction(async tx => {
      const sref = dbx.collection('saves').doc(uid);
      const ssn = await tx.get(sref); const S = ssn.exists ? ssn.data() : null;
      const cid = S && String(S.clan || ''); if (!cid) return;
      const cref = dbx.collection('clans').doc(cid);
      const csn = await tx.get(cref); const C = csn.exists ? csn.data() : null;
      if (!C || !C.cq) return;
      const now = Date.now(), cq = Object.assign({}, C.cq);
      const hits = Object.keys(cq).filter(k => QUESTS[k] && QUESTS[k].ev === ev && cq[k].u === uid && status(cq[k], now) === 'on');
      if (!hits.length) return;
      const wins = [];
      for (const k of hits) {
        const q = Object.assign({}, cq[k]); q.p = Math.min(q.tg, (q.p | 0) + n);
        if (q.p >= q.tg) { q.done = now; q.cd = now + DAY; wins.push(k); }
        cq[k] = q;
      }
      let dep = null, dref = null;
      if (wins.length) { dref = cref.collection('dep').doc('cq'); const dsn = await tx.get(dref); dep = dsn.exists ? dsn.data() : { name: 'Задания клана', gold: 0, iron: 0 }; }
      // ---- записи ----
      let xp = C.xp | 0, aw = Object.assign({}, S._aw || {}), tg = 0, ti = 0;
      for (const k of wins) {
        const r = rewardOf(k, cq[k].L | 0 || 1);
        xp += r.x; tg += r.g; ti += r.i; aw.g = (aw.g | 0) + r.mg; aw.i = (aw.i | 0) + r.mi;
        const ts = Date.now();
        tx.set(cref.collection('led').doc(ts.toString(36) + k), { ts, k: 'cq', uid, name: String(S.name || '').slice(0, 20), g: r.g, i: r.i, what: QUESTS[k].n });
      }
      tx.update(cref, wins.length ? { cq, xp } : { cq });
      if (wins.length) {
        tx.set(dref, { name: 'Задания клана', gold: (dep.gold | 0) + tg, iron: (dep.iron | 0) + ti });
        tx.set(sref, Object.assign({}, S, { _aw: aw }));
      }
    });
  } catch (e) { console.error('cq add', ev, e.message); }
}

module.exports = { QUESTS, DAY, MAX_ACTIVE, status, activeOf, take, drop, add, rewardOf };

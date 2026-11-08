// Мировой цикл: мировой босс, территории, войны, казна и постройки клана.
//
// Раньше всё это считал и записывал клиент. Игрок мог открыть консоль браузера
// и дописать в Firestore что угодно: «убить» мирового босса одной записью и
// забрать награду, набить своему клану очки на территории, объявить войну и
// получить за неё серебро с рейтингом, начислить в казну клана миллион.
//
// Теперь жизненный цикл ведёт сервер: клиент только сообщает о событиях
// («я убил столько зверей», «я нанёс столько урона»), а сервер решает, что из
// этого засчитывается, и сам пишет документы.
//
// Всё, что сервер начисляет игроку (серебро, железо, пыль, рейтинг), идёт
// через отложенную награду _aw в сохранении: игрок забирает её при следующем
// сохранении, и начислить её второй раз нельзя.
'use strict';

const DAYMS = 86400000, WEEKMS = 604800000;
const dayNum = now => Math.floor((now + 2 * 3600000) / DAYMS);  // сутки игры — по Израилю
const weekNum = now => Math.floor(now / WEEKMS);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- мировой босс ----------
const WBN = ['Фенрир', 'Хати', 'Скёль', 'Хрунгнир', 'Тиацци', 'Нидхёгг', 'Гарм'];
const WBMAX = 40000;        // базовое здоровье босса
const WBFIGHTS = 24;        // не больше 24 боёв с боссом в сутки (бой раз в час)
const WBSTRIKES = 11;       // ударов за бой (бой 45 секунд, заряд удара 5 секунд)

// ---------- территории ----------
const TER_RATE = 40;        // очков в минуту (охота даёт примерно 10-12 зверей в минуту)
const TER_MAX = 400;        // за раз

// ---------- войны ----------
const WAR_DUR = 86400000;   // война длится сутки
const WAR_WIN = 200, WAR_DRAW = 80, WAR_LOSE = 40, WAR_RT = 40;

// ---------- клан ----------
const CXK = 10;             // 1 очко опыта клана за каждые 10 урона
const CMAXL = 10;
const cNeed = L => Math.round(22500 * Math.pow(L, 1.7));
function cLv(xp) { let L = 1, x = Math.max(0, xp | 0); while (L < CMAXL && x >= cNeed(L)) { x -= cNeed(L); L++; } return L; }
const cCap = L => 5 + 3 * (L - 1);

// ---------- мировой босс ----------
// верхняя граница атаки героя — по сохранению сервера.
// Очки умений сервер проверяет (не больше 3 за уровень), вещи — проверка вещей,
// поэтому эту границу нельзя накрутить.
function atkBound(s) {
  const st = (s && s.st) || {};
  let a = (st.str | 0) * 2;
  const eq = (s && s.eq) || {};
  for (const k in eq) { const it = eq[k]; if (it && it.b) a += (+it.b.atk || 0); }
  return Math.max(1, Math.round(a * 1.4)) + 10;  // запас на бонус сета и питомца
}
// сколько урона герой может нанести боссу за сутки
function bossDayCap(s) { return Math.round(atkBound(s) * 1.2 * WBSTRIKES * WBFIGHTS); }

// здоровье босса подстраивается: убили быстро — завтра крепче, не убили — слабее
function bossMax(prev) {
  const base = (prev && prev.max) || WBMAX;
  let f = 1;
  if (prev) {
    if (prev.killed && prev.kt) {
      const h = (prev.kt - (prev.day * DAYMS - 2 * 3600000)) / 3600000;
      f = h < 4 ? 1.6 : h < 10 ? 1.35 : h < 18 ? 1.15 : 1;
    } else if (!prev.killed) f = .8;
  }
  return Math.max(WBMAX, Math.min(5e6, Math.round(base * f / 1000) * 1000));
}

// свободно в казне: сумма вкладов минус потраченное
function treasury(depDocs, spent) {
  let g = 0, i = 0;
  for (const d of depDocs) { g += d.gold | 0; i += d.iron | 0; }
  return { g: g - ((spent && spent.gold) | 0), i: i - ((spent && spent.iron) | 0) };
}

module.exports = function cycle(getDb) {
  const db = () => getDb();
  const err = (c, send, rid) => send(c, { t: rid + 'e', rid });

  // достаёт (или создаёт) босса на сегодня; по вчерашнему считается новое здоровье
  async function bossTx(tx, day, yref) {
    const ref = db().collection('world').doc('b' + day);
    const sn = await tx.get(ref);
    if (sn.exists) return { ref, B: sn.data() };
    const ysn = yref ? await tx.get(yref) : null;
    const prev = ysn && ysn.exists ? ysn.data() : null;
    const max = bossMax(prev);
    const B = { day, hp: max, max, dmg: {}, nm: {}, killed: false };
    tx.set(ref, B);
    return { ref, B };
  }

  // урон по боссу: клиент присылает цифру, сервер решает, сколько засчитать
  async function onBoss(c, m, send) {
    const dbx = db(); if (!dbx || !c.uid) return;
    const now = Date.now(), day = dayNum(now);
    const ref = dbx.collection('world').doc('b' + day);
    const yref = dbx.collection('world').doc('b' + (day - 1));
    const sref = dbx.collection('saves').doc(c.uid);
    let out = null;
    try {
      await dbx.runTransaction(async tx => {
        const { B } = await bossTx(tx, day, yref);
        const sn = await tx.get(sref); const S = sn.exists ? sn.data() : null;
        if (!S || B.killed) { out = { st: 'no' }; return; }
        const mine = (B.dmg && B.dmg[c.uid]) | 0;
        const capAll = bossDayCap(S);
        if (mine >= capAll) { out = { st: 'cap', hp: B.hp, max: B.max, mine }; return; }
        // один удар не может превышать атаку героя
        let d = Math.round(+m.d || 0);
        const one = Math.max(1, Math.round(atkBound(S) * 1.2));
        if (!(d > 0)) d = 0; else if (d > one) d = one;
        if (mine + d > capAll) d = Math.max(0, capAll - mine);
        if (!d) { out = { st: 'no', hp: B.hp, max: B.max, mine }; return; }
        B.dmg = B.dmg || {}; B.nm = B.nm || {};
        B.dmg[c.uid] = mine + d; B.nm[c.uid] = String(S.name || c.uid).slice(0, 20);
        B.hp = Math.max(0, (B.hp | 0) - d);
        let kill = false;
        if (B.hp <= 0 && !B.killed) { B.killed = true; B.kt = now; kill = true; }
        tx.set(ref, B);
        const tot = Object.values(B.dmg).reduce((a, b) => a + (b | 0), 0) || 1;
        out = { st: 'ok', hp: B.hp, max: B.max, mine: B.dmg[c.uid], dealt: d, kill, total: tot };
      });
    } catch (e) { console.error('boss dmg', e.message); return err(c, send, 'wb'); }
    send(c, { t: 'wbs', rid: 'wb', ...out });
  }

  // награда за босса: долю урона считает сервер, числа начисляет сервер
  async function onBossClaim(c, m, send) {
    const dbx = db(); if (!dbx || !c.uid) return;
    const now = Date.now(), key = String(m.k || '');
    const ref = dbx.collection('world').doc(key);
    const sref = dbx.collection('saves').doc(c.uid);
    let out = null;
    try {
      await dbx.runTransaction(async tx => {
        const sn = await tx.get(ref); if (!sn.exists) { out = { st: 'no' }; return; }
        const B = sn.data(); if (!B.killed) { out = { st: 'no' }; return; }
        const mine = (B.dmg && B.dmg[c.uid]) | 0;
        if (mine <= 0) { out = { st: 'no' }; return; }
        const ssn = await tx.get(sref); const S = ssn.exists ? ssn.data() : null;
        if (!S) { out = { st: 'no' }; return; }
        if ((S.wbcl || []).includes(key)) { out = { st: 'done' }; return; }
        const tot = Object.values(B.dmg).reduce((a, b) => a + (b | 0), 0) || 1;
        const sh = Math.min(1, mine / tot);
        const lvl = Math.max(1, S.lvl | 0);
        const g = Math.round(300 + 3000 * sh + lvl * 10);       // серебро
        const ir = Math.round(30 + 200 * sh);                   // железо
        const dust = 5;                                        // пыль
        const aw = Object.assign({}, S._aw || {}, {
          g: (S._aw && S._aw.g || 0) + g, i: (S._aw && S._aw.i || 0) + ir, d: (S._aw && S._aw.d || 0) + dust
        });
        tx.set(sref, Object.assign({}, S, { _aw: aw, wbcl: [...(S.wbcl || []), key].slice(-10) }));
        out = { st: 'ok', k: key, g, ir, dust, sh: Math.round(sh * 100) };
      });
    } catch (e) { console.error('boss claim', e.message); return err(c, send, 'wb'); }
    send(c, { t: 'wbc', rid: 'wb', ...out });
  }

  // ---------- охота: зверей поймал, урон набежал ----------
  // Клиент сообщает: сколько зверей убито в каждой местности и сколько урона
  // набежало. Сервер ограничивает и то, и другое: зверей — по частоте отлова,
  // урон — по числу зверей и по атаке героя.
  async function onHunt(c, m, send) {
    const dbx = db(); if (!dbx || !c.uid) return;
    const now = Date.now(), wk = weekNum(now);
    const sref = dbx.collection('saves').doc(c.uid);
    const q = (m && m.q) || {};
    let kills = 0;
    for (const k of ['easy', 'mid', 'hard']) { const n = Math.floor(+q[k] || 0); if (n > 0) kills += n; }
    const dmg = Math.max(0, Math.floor(+m.d || 0));
    if (!(kills > 0) && !(dmg > 0)) return;
    let out = null;
    try {
      await dbx.runTransaction(async tx => {
        const sn = await tx.get(sref); const S = sn.exists ? sn.data() : null;
        if (!S) { out = { st: 'no' }; return; }
        const cid = String(S.clan || '');
        // ограничение по частоте: зверей не больше, чем игрок может поймать
        const led = S._tp || { t: now, n: 0 };
        const dt = Math.max(0, (now - (led.t || now)) / 60000);
        const room = Math.max(0, TER_RATE * dt - (led.n | 0)) + 4;
        const take = Math.min(kills, Math.floor(room));
        if (!(take > 0)) { out = { st: 'rate', took: 0 }; return; }
        // урон ограничен атакой героя и числом зверей
        const capD = Math.round(atkBound(S) * 1.2 * take + 50);
        const takeD = Math.min(dmg, capD);
        // ВАЖНО: в транзакции Firestore все чтения идут ДО всех записей.
        // Поэтому сначала читаем документы территорий и клана, потом пишем.
        const terrs = [];
        if (cid) {
          for (const k of ['easy', 'mid', 'hard']) {
            const n = Math.floor(+q[k] || 0); if (!(n > 0)) continue;
            const tref = dbx.collection('terr').doc(k);
            const tsn = await tx.get(tref);
            terrs.push({ k, n, ref: tref, T: tsn.exists ? Object.assign({}, tsn.data()) : { wk, pts: {}, names: {} } });
          }
        }
        let C = null;
        const cref = cid ? dbx.collection('clans').doc(cid) : null;
        if (cref && takeD > 0) { const csn = await tx.get(cref); C = csn.exists ? csn.data() : null; }
        // ---- записи ----
        // 1. территории: по одному очку за зверя
        for (const it of terrs) {
          const T = it.T;
          if (T.wk !== wk) {   // новая неделя: очки обнуляются, владелец сохраняется
            const e = Object.entries(T.pts || {}).sort((a, b) => (b[1] | 0) - (a[1] | 0))[0];
            T.wk = wk; T.pts = {}; T.names = {};
            T.owner = e ? e[0] : (T.owner || ''); T.oname = e ? ((T.names || {})[e[0]] || '') : (T.oname || '');
          }
          T.pts = T.pts || {}; T.names = T.names || {};
          const share = Math.max(1, Math.round(it.n * take / kills));
          T.pts[cid] = (T.pts[cid] | 0) + share;
          T.names[cid] = String(S.name || cid).slice(0, 20);
          tx.set(it.ref, T);
        }
        // 2. опыт клана и недельное задание
        if (C) {
          const cx = Math.floor(takeD / CXK);
          const nx = (C.xp | 0) + cx;
          const w = (C.wq && C.wq.wk === wk) ? C.wq : { wk, xp: 0 };
          tx.update(cref, { xp: nx, wq: { wk, xp: (w.xp | 0) + cx } });
        }
        // 3. счётчик частоты — в сохранение игрока
        tx.set(sref, Object.assign({}, S, { _tp: { t: now, n: (led.n | 0) + take } }));
        out = { st: 'ok', took: take, dmg: takeD };
      });
    } catch (e) { console.error('hunt', e.message); return err(c, send, 'hunt'); }
    send(c, { t: 'hunts', rid: 'hunt', ...out });
  }

  // ---------- войны ----------
  // объявление войны: документ создаёт сервер
  async function onWar(c, m, send) {
    const dbx = db(); if (!dbx || !c.uid) return;
    const now = Date.now();
    const cid = String(m.cid || '');
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(cid)) return err(c, send, 'war');
    const sref = dbx.collection('saves').doc(c.uid);
    let out = null;
    // ВАЖНО: в транзакции Firestore запросы запрещены — занятость кланов
    // проверяем заранее, до открытия транзакции.
    let busy = false;
    try {
      const q = await dbx.collection('wars').where('end', '>', now).limit(30).get();
      for (const d of q.docs) {
        const W = d.data();
        if (W.a === cid || W.b === cid) { busy = true; break; }
      }
    } catch (e) {}
    try {
      await dbx.runTransaction(async tx => {
        const sn = await tx.get(sref); const S = sn.exists ? sn.data() : null;
        if (!S) { out = { st: 'no' }; return; }
        const my = String(S.clan || '');
        if (!my) { out = { st: 'nocl' }; return; }
        // объявлять войну может только глава своего клана
        const msn = await tx.get(dbx.collection('clans').doc(my));
        const M = msn.exists ? msn.data() : null;
        if (!M || M.leader !== c.uid) { out = { st: 'notlead' }; return; }
        if (my === cid) { out = { st: 'self' }; return; }
        if (busy) { out = { st: 'busy' }; return; }
        const id = 'w' + now.toString(36) + Math.random().toString(36).slice(2, 6);
        tx.set(dbx.collection('wars').doc(id), { a: my, b: cid, end: now + WAR_DUR, ts: now, w: {} });
        out = { st: 'ok', id, a: my, b: cid, end: now + WAR_DUR };
      });
    } catch (e) { console.error('war', e.message); return err(c, send, 'war'); }
    send(c, { t: 'wars', rid: 'war', ...out });
  }

  // итог войны: очки считает сервер, награду начисляет сервер
  async function onWarClaim(c, m, send) {
    const dbx = db(); if (!dbx || !c.uid) return;
    const now = Date.now(), id = String(m.id || '');
    const wref = dbx.collection('wars').doc(id);
    const sref = dbx.collection('saves').doc(c.uid);
    let out = null;
    try {
      await dbx.runTransaction(async tx => {
        const sn = await tx.get(wref); if (!sn.exists) { out = { st: 'no' }; return; }
        const W = sn.data();
        const ssn = await tx.get(sref); const S = ssn.exists ? ssn.data() : null;
        if (!S) { out = { st: 'no' }; return; }
        const cid = String(S.clan || '');
        if (!cid || (cid !== W.a && cid !== W.b)) { out = { st: 'nocl' }; return; }
        if ((S.wclaim || []).includes(id)) { out = { st: 'done' }; return; }
        if (now < W.end) { out = { st: 'early', end: W.end }; return; }
        const w = W.w || {};
        const x = (w[cid] || 0) | 0, o = cid === W.a ? (w[W.b] || 0) | 0 : (w[W.a] || 0) | 0;
        let g = WAR_LOSE, rt = 0;
        if (x > o) { g = WAR_WIN; rt = WAR_RT; } else if (x === o) g = WAR_DRAW;
        const aw = Object.assign({}, S._aw || {}, { g: (S._aw && S._aw.g || 0) + g, rt: (S._aw && S._aw.rt || 0) + rt });
        tx.set(sref, Object.assign({}, S, { _aw: aw, wclaim: [...(S.wclaim || []), id].slice(-20) }));
        out = { st: 'ok', id, g, rt, win: x > o, draw: x === o, x, o };
      });
    } catch (e) { console.error('war claim', e.message); return err(c, send, 'war'); }
    send(c, { t: 'warc', rid: 'war', ...out });
  }

  // ---------- клан: казна, задание, постройки ----------
  // документ вклада в казну клана
  async function addDep(tx, dbx, cid, doc, name, gold, iron) {
    const ref = dbx.collection('clans').doc(cid).collection('dep').doc(doc);
    const sn = await tx.get(ref);
    const o = sn.exists ? sn.data() : { name, gold: 0, iron: 0 };
    tx.set(ref, { name, gold: (o.gold | 0) + (gold | 0), iron: (o.iron | 0) + (iron | 0) });
  }
  async function onClan(c, m, send) {
    const dbx = db(); if (!dbx || !c.uid) return;
    const now = Date.now(), wk = weekNum(now);
    const kind = String(m.k || '');
    const sref = dbx.collection('saves').doc(c.uid);
    let out = null;
    try {
      await dbx.runTransaction(async tx => {
        const sn = await tx.get(sref); const S = sn.exists ? sn.data() : null;
        if (!S) { out = { st: 'no' }; return; }
        const cid = String(S.clan || '');
        if (!cid) { out = { st: 'nocl' }; return; }
        const cref = dbx.collection('clans').doc(cid);
        const csn = await tx.get(cref); const C = csn.exists ? csn.data() : null;
        if (!C) { out = { st: 'no' }; return; }
        const isLead = C.leader === c.uid;

        if (kind === 'quest') {
          // задание недели: очки выполнения считает сервер (см. onHunt)
          const w = (C.wq && C.wq.wk === wk) ? C.wq : { wk, xp: 0 };
          const L = cLv(C.xp | 0);
          const need = 20000 * L;
          if (w.done) { out = { st: 'done' }; return; }
          if ((w.xp | 0) < need) { out = { st: 'no' }; return; }
          const g = 1500 * L, ir = Math.round(g / 20);
          // читаем казну до любой записи — правило транзакций Firestore
          const dref = dbx.collection('clans').doc(cid).collection('dep').doc('quest');
          const dsn = await tx.get(dref);
          const o = dsn.exists ? dsn.data() : { name: 'Задания клана', gold: 0, iron: 0 };
          tx.update(cref, { wq: { wk, xp: w.xp | 0, done: true } });
          tx.set(dref, { name: 'Задания клана', gold: (o.gold | 0) + g, iron: (o.iron | 0) + ir });
          out = { st: 'ok', k: 'quest', g, i: ir };
        } else if (kind === 'dungeon') {
          // доля с подземелья: сколько железа игрок принёс
          const n = Math.floor(+m.n || 0);
          if (!(n > 0) || n > 100000) { out = { st: 'no' }; return; }
          await addDep(tx, dbx, cid, 'dungeon', 'Подземелье клана', 0, n);
          out = { st: 'ok', k: 'dungeon', i: n };
        } else if (kind === 'build') {
          // постройка: деньги из казны, уровень постройки пишет сервер
          const key = String(m.b || '');
          const BLD = { bar: 'Казармы', wall: 'Крепостная стена', inf: 'Лазарет', mkt: 'Торговый двор', frg: 'Клановая кузня' };
          const B = BLD[key]; if (!B) { out = { st: 'no' }; return; }
          if (!isLead) { out = { st: 'notlead' }; return; }
          const lv = ((C.b || {})[key] | 0);
          if (lv >= 5) { out = { st: 'max' }; return; }
          const cost = { g: 150 * (lv + 1) * (lv + 1), i: 20 * (lv + 1) };   // как в игре
          const dsn = await tx.get(dbx.collection('clans').doc(cid).collection('dep').limit(100));
          const depDocs = dsn.docs.map(d => d.data());
          const tr = treasury(depDocs, C.spent);
          if (tr.g < cost.g || tr.i < cost.i) { out = { st: 'nomoney', need: cost }; return; }
          const b = Object.assign({}, C.b || {});
          b[key] = lv + 1;
          const spent = { gold: ((C.spent || {}).gold | 0) + cost.g, iron: ((C.spent || {}).iron | 0) + cost.i };
          tx.update(cref, { b, spent });
          out = { st: 'ok', k: 'build', b: key, lv: lv + 1, cost };
        } else { out = { st: 'no' }; return; }
      });
    } catch (e) { console.error('clan', e.message); return err(c, send, 'clan'); }
    send(c, { t: 'clans', rid: 'clan', ...out });
  }

  async function onMsg(c, m, send) {
    if (!c.uid) return;
    if (m.t === 'wb') return onBoss(c, m, send);
    if (m.t === 'wbcl') return onBossClaim(c, m, send);
    if (m.t === 'hunt') return onHunt(c, m, send);
    if (m.t === 'war') return onWar(c, m, send);
    if (m.t === 'warc') return onWarClaim(c, m, send);
    if (m.t === 'clan') return onClan(c, m, send);
  }

  return { onMsg, stats: () => ({ day: dayNum(Date.now()), week: weekNum(Date.now()) }) };
};

module.exports.bossMax = bossMax;
module.exports.atkBound = atkBound;
module.exports.bossDayCap = bossDayCap;
module.exports.cLv = cLv;
module.exports.cNeed = cNeed;
module.exports.cCap = cCap;
module.exports.treasury = treasury;
module.exports.TER_RATE = TER_RATE;
module.exports.WAR_WIN = WAR_WIN;
module.exports.WAR_DRAW = WAR_DRAW;
module.exports.WAR_LOSE = WAR_LOSE;
module.exports.WAR_RT = WAR_RT;
module.exports.dayNum = dayNum;
module.exports.weekNum = weekNum;

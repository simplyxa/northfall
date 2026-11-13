// Правила доступа к данным для клиентов игры: перенос firestore.rules в код сервера (шлюз server/fsgate.js).
// Клиент больше не говорит с базой напрямую: каждый запрос проходит через check().
// Сервер (Admin SDK / pgdocs) эти правила обходит, как и раньше обходил Firestore.
// Любое, чего здесь нет, ЗАПРЕЩЕНО.
'use strict';

const ADMINS = ['shtorm1', 'admin'];                 // как в firestore.rules и server/saves.js
const DOM = '@northfall.game';

// auth: { uid } — логин (часть почты до @), или null для не вошедшего
function authFromEmail(email) {
  if (!email || !String(email).endsWith(DOM)) return null;
  const uid = String(email).slice(0, -DOM.length);
  return { uid, admin: ADMINS.includes(uid) };
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const keys = d => isObj(d) ? Object.keys(d) : [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// как request.resource.data.diff(resource.data).affectedKeys(): ключи верхнего уровня, которые добавлены, удалены или изменены
function affected(a, b) { const o = new Set([...keys(a), ...keys(b)]); return [...o].filter(k => !same((a || {})[k], (b || {})[k])); }
const hasOnly = (arr, allowed) => arr.every(k => allowed.includes(k));
const hasAny = (arr, list) => arr.some(k => list.includes(k));
const str = (v, max) => typeof v === 'string' && v.length <= max;

const PROT = ['rating', 'srat', 'win', 'arw', 'lose', 'sid', 'psid', 'psrat', 'lvl', 'dr', 'dw', 'dn'];   // поля карточки игрока: только сервер
const CLAN_SRV = ['xp', 'wq', 'dq', 'cq', 'b', 'spent'];

// op: 'read' | 'create' | 'update' | 'delete'. segs — путь документа. existing — данные до записи (или null),
// incoming — данные после записи (для create/update), getDoc(path) — чтение другого документа (для refs).
async function check(op, segs, auth, existing, incoming, getDoc) {
  const c = segs[0], n = segs.length;           // n нечётное — коллекция, чётное — документ
  const signed = !!auth, uid = auth ? auth.uid : null, adm = !!(auth && auth.admin);
  const me = id => signed && uid === id;
  const W = op !== 'read';

  if (c === 'saves' && n === 2) {
    if (op === 'read' || op === 'delete') return me(segs[1]) || adm;
    return false;
  }
  if (c === 'arlist') return n === 2 && op === 'read' && (me(segs[1]) || adm);
  if (c === 'arhist') return n === 2 && op === 'read' && (me(segs[1]) || adm);
  if (c === 'wallet') {
    if (n === 2) return op === 'read' && (me(segs[1]) || adm);
    if (n === 4 && segs[2] === 'log') return op === 'read' && (me(segs[1]) || adm);
    return false;
  }
  if (c === 'bugs' && n === 2) {
    if (op === 'create') return signed && isObj(incoming) && incoming.uid === uid && str(incoming.text, 1000);
    if (op === 'read' || op === 'delete') return adm;
    return false;
  }
  if (c === 'names' && n === 2) {
    if (op === 'read') return true;                                   // нужно для входа по нику
    if (op === 'create') return signed && isObj(incoming) && incoming.uid === uid;
    if (op === 'update' || op === 'delete') return signed && !!existing && existing.uid === uid && (op === 'delete' || (isObj(incoming) && incoming.uid === uid));
    return false;
  }
  if (c === 'players' && n === 2) {
    if (op === 'read') return signed;
    if (op === 'delete') return me(segs[1]) || adm;
    return adm || (me(segs[1]) && (existing === null
      ? !hasAny(keys(incoming), PROT)
      : !hasAny(affected(existing, incoming), PROT)));
  }
  if (c === 'admin' && n === 2) return op === 'read' ? signed : adm;
  if (c === 'clans') {
    if (n === 2) {
      if (op === 'read') return signed;
      if (op === 'create') return signed && !hasAny(keys(incoming), CLAN_SRV);
      if (op === 'update') return signed && !hasAny(affected(existing, incoming), CLAN_SRV);
      return false;                                                   // удаление клана — только сервер
    }
    if (n === 4 && ['chat', 'log', 'dun'].includes(segs[2])) return signed;
    if (n === 4 && (segs[2] === 'dep' || segs[2] === 'led')) return op === 'read' && signed;
    // форум клана: темы (n=4) и сообщения (n=6). Читают все вошедшие, пишут от своего имени;
    // удалять и закреплять могут автор, лидер/офицеры клана и админ
    if ((n === 4 && segs[2] === 'ft') || (n === 6 && segs[2] === 'ft' && segs[4] === 'fp')) {
      if (!signed) return false;
      if (op === 'read') return true;
      const post = n === 6;
      const mod = async () => {
        if (adm) return true;
        if (existing && existing.uid === uid) return true;
        const cl = await getDoc('clans/' + segs[1]);
        return !!cl && (cl.leader === uid || (cl.off || []).includes(uid));
      };
      if (op === 'create') return isObj(incoming) && incoming.uid === uid && (post ? str(incoming.text, 1000) : str(incoming.title, 80));
      if (op === 'update') {
        if (post) return false;
        const ch = affected(existing, incoming);
        if (hasOnly(ch, ['last', 'n', 'lby'])) return true;                 // любой участник отмечает новый ответ
        return hasOnly(ch, ['pin']) && await mod();                         // закреплять — автор и модераторы
      }
      if (op === 'delete') return await mod();
      return false;
    }
    return false;
  }
  if ((c === 'wars' || c === 'world' || c === 'terr' || c === 'market') && n === 2) return op === 'read' && signed;
  if (c === 'forum') {
    if (n === 2) return op === 'delete' ? adm : signed;
    if (n === 4 && segs[2] === 'posts') return (op === 'read' || op === 'create') ? signed : (op === 'update' || op === 'delete') && adm;
    return false;
  }
  if (c === 'pay' && n === 4 && segs[2] === 'orders') {
    if (op === 'read') return me(segs[1]) || adm;
    if (op === 'update') return me(segs[1]) && hasOnly(affected(existing, incoming), ['claimed']);
    return false;
  }
  if (c === 'payments' && n === 2) return op === 'read' && adm;
  if (c === 'friends' && n === 2) {
    const e = existing || {};
    if (op === 'read') return signed && (existing === null || uid === e.a || uid === e.b);
    const nw = incoming || {};
    if (op === 'create') return signed && nw.by === uid && (uid === nw.a || uid === nw.b) && segs[1] === nw.a + '~' + nw.b && nw.st === 'p';
    if (op === 'update') return signed && !!existing && (uid === e.a || uid === e.b) && nw.a === e.a && nw.b === e.b && nw.by === e.by
      && (nw.st === e.st || (e.by !== uid && nw.st === 'ok'));
    if (op === 'delete') return signed && !!existing && (uid === e.a || uid === e.b);
    return false;
  }
  if (c === 'dm' && n === 4 && segs[2] === 'm') {
    const inPair = signed && segs[1].split('~').includes(uid);
    if (op === 'read') return inPair;
    if (op === 'create') return inPair && isObj(incoming) && incoming.from === uid && str(incoming.text, 500);
    if (op === 'update') return inPair && !!existing && uid !== existing.from && (existing.claimed === undefined ? true : existing.claimed) === false
      && hasOnly(affected(existing, incoming), ['claimed']) && incoming.claimed === true;
    return false;
  }
  if (c === 'dmi' && n === 4 && segs[2] === 'c') {
    if (op === 'read') return signed && uid === segs[1];
    return signed && (uid === segs[1] || uid === segs[3]);
  }
  if (c === 'refs' && n === 4 && segs[2] === 'got') {
    const rid = segs[1], nid = segs[3];
    if (op === 'read') return signed && (uid === rid || uid === nid);
    if (op === 'create') return signed && uid === nid && nid !== rid && isObj(incoming) && incoming.done === false;
    if (op === 'update') {
      if (!signed || !existing) return false;
      const aff = affected(existing, incoming);
      if (uid === nid && hasOnly(aff, ['done', 'doneTs']) && incoming.done === true) {
        const sv = await getDoc('saves/' + nid);
        return !!sv && Number(sv.lvl) >= 10;
      }
      return uid === rid && existing.done === true && hasOnly(aff, ['claimed']);
    }
    return false;
  }
  if (c === 'raidq' && n === 2) return signed;
  if (c === 'raids') {
    if (n === 2) return signed && op !== 'delete';
    if (n === 4 && segs[2] === 'a') return op === 'read' ? signed : (signed && uid === segs[3]);
    return false;
  }
  if (c === 'chat' && n === 2) {
    if (op === 'read') return signed;
    if (op === 'create') return signed && isObj(incoming) && incoming.uid === uid && str(incoming.text, 200);
    if (op === 'delete') return adm;
    return false;
  }
  return false;
}

module.exports = { check, authFromEmail, ADMINS, _affected: affected };

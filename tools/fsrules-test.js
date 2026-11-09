#!/usr/bin/env node
'use strict';
// Тесты правил доступа клиентов (server/fsrules.js) — каждая строка firestore.rules: что разрешено и что запрещено.
const { check, authFromEmail } = require('../server/fsrules');
let ok = 0, bad = 0;
const U = authFromEmail('alice@northfall.game'), B = authFromEmail('bob@northfall.game'), ADM = authFromEmail('admin@northfall.game'), ANON = null;
const getDoc = async p => p === 'saves/alice' ? { lvl: 12 } : p === 'saves/bob' ? { lvl: 3 } : null;
async function T(name, op, path, auth, ex, inc, want) {
  const got = await check(op, path.split('/'), auth, ex, inc, getDoc);
  if (got === want) ok++; else { bad++; console.log('  ✗ ' + name + ' (ожидалось ' + want + ', получено ' + got + ')'); }
}
(async () => {
  console.log('\nПравила доступа клиентов\n');
  // сохранения
  await T('saves: свой read', 'read', 'saves/alice', U, {}, null, true);
  await T('saves: чужой read', 'read', 'saves/bob', U, {}, null, false);
  await T('saves: админ read', 'read', 'saves/bob', ADM, {}, null, true);
  await T('saves: запись клиентом запрещена', 'update', 'saves/alice', U, {}, {}, false);
  await T('saves: create запрещён', 'create', 'saves/alice', U, null, {}, false);
  await T('saves: свой delete', 'delete', 'saves/alice', U, {}, null, true);
  await T('saves: чужой delete', 'delete', 'saves/bob', U, {}, null, false);
  await T('saves: аноним', 'read', 'saves/alice', ANON, {}, null, false);
  // кошелёк
  await T('wallet: свой read', 'read', 'wallet/alice', U, {}, null, true);
  await T('wallet: чужой read', 'read', 'wallet/bob', U, {}, null, false);
  await T('wallet: запись', 'update', 'wallet/alice', U, {}, { au: 9e9 }, false);
  await T('wallet/log: свой read', 'read', 'wallet/alice/log/x', U, {}, null, true);
  await T('wallet/log: запись', 'create', 'wallet/alice/log/x', U, null, {}, false);
  await T('wallet/claims: не описано → запрет', 'read', 'wallet/alice/claims/x', U, {}, null, false);
  // закрытые
  for (const c of ['priv', 'push']) { await T(c + ': read', 'read', c + '/alice', U, {}, null, false); await T(c + ': админ', 'read', c + '/alice', ADM, {}, null, false); }
  // баги
  await T('bugs: create', 'create', 'bugs/1', U, null, { uid: 'alice', text: 'x' }, true);
  await T('bugs: чужой uid', 'create', 'bugs/1', U, null, { uid: 'bob', text: 'x' }, false);
  await T('bugs: длинный текст', 'create', 'bugs/1', U, null, { uid: 'alice', text: 'x'.repeat(1001) }, false);
  await T('bugs: read не админ', 'read', 'bugs/1', U, {}, null, false);
  await T('bugs: read админ', 'read', 'bugs/1', ADM, {}, null, true);
  await T('bugs: delete админ', 'delete', 'bugs/1', ADM, {}, null, true);
  // ники
  await T('names: read без входа', 'read', 'names/zed', ANON, {}, null, true);
  await T('names: create свой', 'create', 'names/zed', U, null, { uid: 'alice' }, true);
  await T('names: create чужой uid', 'create', 'names/zed', U, null, { uid: 'bob' }, false);
  await T('names: create без входа', 'create', 'names/zed', ANON, null, { uid: 'alice' }, false);
  await T('names: update свой', 'update', 'names/zed', U, { uid: 'alice' }, { uid: 'alice', name: 'Z' }, true);
  await T('names: захват чужого', 'update', 'names/zed', U, { uid: 'bob' }, { uid: 'alice' }, false);
  await T('names: передача другому', 'update', 'names/zed', U, { uid: 'alice' }, { uid: 'bob' }, false);
  await T('names: delete своего', 'delete', 'names/zed', U, { uid: 'alice' }, null, true);
  await T('names: delete чужого', 'delete', 'names/zed', U, { uid: 'bob' }, null, false);
  // карточки игроков
  await T('players: read', 'read', 'players/bob', U, {}, null, true);
  await T('players: read без входа', 'read', 'players/bob', ANON, {}, null, false);
  await T('players: create без защищённых полей', 'create', 'players/alice', U, null, { ssum: 5 }, true);
  await T('players: create с рейтингом', 'create', 'players/alice', U, null, { rating: 9999 }, false);
  await T('players: update не защищённого', 'update', 'players/alice', U, { lvl: 5, rating: 1 }, { lvl: 5, rating: 1, seen: 1 }, true);
  await T('players: update рейтинга', 'update', 'players/alice', U, { rating: 1 }, { rating: 5000 }, false);
  await T('players: update чужого', 'update', 'players/bob', U, { a: 1 }, { a: 2 }, false);
  await T('players: админ может', 'update', 'players/bob', ADM, { rating: 1 }, { rating: 2 }, true);
  await T('players: свой delete', 'delete', 'players/alice', U, {}, null, true);
  await T('players: чужой delete', 'delete', 'players/bob', U, {}, null, false);
  // admin
  await T('admin: read', 'read', 'admin/x', U, {}, null, true);
  await T('admin: write не админ', 'update', 'admin/x', U, {}, {}, false);
  await T('admin: write админ', 'update', 'admin/x', ADM, {}, {}, true);
  // кланы
  await T('clans: read', 'read', 'clans/c1', U, {}, null, true);
  await T('clans: create', 'create', 'clans/c1', U, null, { name: 'W', leader: 'alice' }, true);
  await T('clans: create с xp', 'create', 'clans/c1', U, null, { name: 'W', xp: 9999 }, false);
  await T('clans: update состава', 'update', 'clans/c1', U, { name: 'W' }, { name: 'W', kicked: ['x'] }, true);
  await T('clans: update xp', 'update', 'clans/c1', U, { name: 'W', xp: 1 }, { name: 'W', xp: 9999 }, false);
  await T('clans: update казны b', 'update', 'clans/c1', U, { name: 'W' }, { name: 'W', b: { x: 1 } }, false);
  await T('clans: delete клиентом', 'delete', 'clans/c1', U, {}, null, false);
  for (const s of ['chat', 'log', 'dun']) { await T('clans/' + s + ': write', 'create', 'clans/c1/' + s + '/m', U, null, { t: 1 }, true); await T('clans/' + s + ': аноним', 'read', 'clans/c1/' + s + '/m', ANON, {}, null, false); }
  await T('clans/dep: read', 'read', 'clans/c1/dep/alice', U, {}, null, true);
  await T('clans/dep: write', 'create', 'clans/c1/dep/alice', U, null, { gold: 9e9 }, false);
  await T('clans/unknown: запрет', 'read', 'clans/c1/zzz/x', U, {}, null, false);
  // серверные коллекции
  for (const c of ['wars', 'world', 'terr', 'market']) { await T(c + ': read', 'read', c + '/x', U, {}, null, true); await T(c + ': write', 'update', c + '/x', U, {}, {}, false); await T(c + ': админ write', 'update', c + '/x', ADM, {}, {}, false); await T(c + ': аноним', 'read', c + '/x', ANON, {}, null, false); }
  // форум
  await T('forum: create', 'create', 'forum/t', U, null, { title: 'x' }, true);
  await T('forum: update', 'update', 'forum/t', U, {}, { a: 1 }, true);
  await T('forum: delete не админ', 'delete', 'forum/t', U, {}, null, false);
  await T('forum: delete админ', 'delete', 'forum/t', ADM, {}, null, true);
  await T('forum/posts: create', 'create', 'forum/t/posts/p', U, null, { text: 'x' }, true);
  await T('forum/posts: update не админ', 'update', 'forum/t/posts/p', U, {}, { text: 'y' }, false);
  await T('forum/posts: delete админ', 'delete', 'forum/t/posts/p', ADM, {}, null, true);
  await T('forum: аноним', 'read', 'forum/t', ANON, {}, null, false);
  // заказы и платежи
  await T('pay/orders: свой read', 'read', 'pay/alice/orders/o', U, {}, null, true);
  await T('pay/orders: чужой read', 'read', 'pay/bob/orders/o', U, {}, null, false);
  await T('pay/orders: claimed', 'update', 'pay/alice/orders/o', U, { gold: 5, claimed: false }, { gold: 5, claimed: true }, true);
  await T('pay/orders: правка суммы', 'update', 'pay/alice/orders/o', U, { gold: 5, claimed: false }, { gold: 5000, claimed: true }, false);
  await T('pay/orders: create', 'create', 'pay/alice/orders/o', U, null, { gold: 5 }, false);
  await T('payments: админ', 'read', 'payments/o', ADM, {}, null, true);
  await T('payments: игрок', 'read', 'payments/o', U, {}, null, false);
  // друзья
  const fr = { a: 'alice', b: 'bob', by: 'alice', st: 'p' };
  await T('friends: участник read', 'read', 'friends/alice~bob', B, fr, null, true);
  await T('friends: посторонний read', 'read', 'friends/alice~bob', authFromEmail('eve@northfall.game'), fr, null, false);
  await T('friends: read несуществующего', 'read', 'friends/alice~bob', U, null, null, true);
  await T('friends: create', 'create', 'friends/alice~bob', U, null, fr, true);
  await T('friends: create от чужого имени', 'create', 'friends/alice~bob', U, null, { ...fr, by: 'bob' }, false);
  await T('friends: create без a~b', 'create', 'friends/x', U, null, fr, false);
  await T('friends: create сразу ok', 'create', 'friends/alice~bob', U, null, { ...fr, st: 'ok' }, false);
  await T('friends: принять заявку', 'update', 'friends/alice~bob', B, fr, { ...fr, st: 'ok' }, true);
  await T('friends: принять свою же заявку', 'update', 'friends/alice~bob', U, fr, { ...fr, st: 'ok' }, false);
  await T('friends: смена участников', 'update', 'friends/alice~bob', B, fr, { ...fr, a: 'eve' }, false);
  await T('friends: delete участником', 'delete', 'friends/alice~bob', B, fr, null, true);
  await T('friends: delete посторонним', 'delete', 'friends/alice~bob', authFromEmail('eve@northfall.game'), fr, null, false);
  // личные сообщения
  await T('dm: участник read', 'read', 'dm/alice~bob/m/1', B, {}, null, true);
  await T('dm: посторонний read', 'read', 'dm/alice~bob/m/1', authFromEmail('eve@northfall.game'), {}, null, false);
  await T('dm: create', 'create', 'dm/alice~bob/m/1', U, null, { from: 'alice', text: 'hi' }, true);
  await T('dm: create от чужого имени', 'create', 'dm/alice~bob/m/1', U, null, { from: 'bob', text: 'hi' }, false);
  await T('dm: create длинное', 'create', 'dm/alice~bob/m/1', U, null, { from: 'alice', text: 'x'.repeat(501) }, false);
  await T('dm: create не в паре', 'create', 'dm/alice~bob/m/1', authFromEmail('eve@northfall.game'), null, { from: 'eve', text: 'hi' }, false);
  const mail = { from: 'alice', text: 'item', claimed: false, item: { n: 1 } };
  await T('dm: получатель забирает', 'update', 'dm/alice~bob/m/1', B, mail, { ...mail, claimed: true }, true);
  await T('dm: отправитель забирает свою', 'update', 'dm/alice~bob/m/1', U, mail, { ...mail, claimed: true }, false);
  await T('dm: повторный забор', 'update', 'dm/alice~bob/m/1', B, { ...mail, claimed: true }, { ...mail, claimed: true }, false);
  await T('dm: забор + правка вещи', 'update', 'dm/alice~bob/m/1', B, mail, { ...mail, claimed: true, item: { n: 99 } }, false);
  await T('dm: письмо без claimed', 'update', 'dm/alice~bob/m/1', B, { from: 'alice', text: 'x' }, { from: 'alice', text: 'x', claimed: true }, false);
  await T('dm: delete', 'delete', 'dm/alice~bob/m/1', U, mail, null, false);
  await T('dmi: свой read', 'read', 'dmi/alice/c/bob', U, {}, null, true);
  await T('dmi: чужой read', 'read', 'dmi/bob/c/alice', U, {}, null, false);
  await T('dmi: write в чужой список от своего имени', 'update', 'dmi/bob/c/alice', U, {}, {}, true);
  await T('dmi: write в чужой от чужого', 'update', 'dmi/bob/c/eve', U, {}, {}, false);
  // приглашения
  await T('refs: read приглашавшего', 'read', 'refs/alice/got/bob', U, {}, null, true);
  await T('refs: read постороннего', 'read', 'refs/alice/got/bob', authFromEmail('eve@northfall.game'), {}, null, false);
  await T('refs: create себя', 'create', 'refs/alice/got/bob', B, null, { done: false }, true);
  await T('refs: create за другого', 'create', 'refs/alice/got/bob', U, null, { done: false }, false);
  await T('refs: create себя себе', 'create', 'refs/bob/got/bob', B, null, { done: false }, false);
  await T('refs: create уже done', 'create', 'refs/alice/got/bob', B, null, { done: true }, false);
  await T('refs: done при lvl>=10', 'update', 'refs/bob/got/alice', U, { done: false }, { done: true, doneTs: 1 }, true);
  await T('refs: done при lvl<10', 'update', 'refs/alice/got/bob', B, { done: false }, { done: true, doneTs: 1 }, false);
  await T('refs: done без lvl-проверки полей', 'update', 'refs/bob/got/alice', U, { done: false }, { done: true, claimed: true }, false);
  await T('refs: claimed приглашавшим', 'update', 'refs/alice/got/bob', U, { done: true }, { done: true, claimed: true }, true);
  await T('refs: claimed до done', 'update', 'refs/alice/got/bob', U, { done: false }, { done: false, claimed: true }, false);
  // рейды
  await T('raidq: write', 'update', 'raidq/x', U, {}, {}, true);
  await T('raidq: аноним', 'read', 'raidq/x', ANON, {}, null, false);
  await T('raids: read/update', 'update', 'raids/r', U, {}, {}, true);
  await T('raids: delete', 'delete', 'raids/r', U, {}, null, false);
  await T('raids/a: свой write', 'update', 'raids/r/a/alice', U, {}, {}, true);
  await T('raids/a: чужой write', 'update', 'raids/r/a/bob', U, {}, {}, false);
  await T('raids/a: read', 'read', 'raids/r/a/bob', U, {}, null, true);
  // чат
  await T('chat: read', 'read', 'chat/m', U, {}, null, true);
  await T('chat: create', 'create', 'chat/m', U, null, { uid: 'alice', text: 'hi' }, true);
  await T('chat: от чужого имени', 'create', 'chat/m', U, null, { uid: 'bob', text: 'hi' }, false);
  await T('chat: длинное', 'create', 'chat/m', U, null, { uid: 'alice', text: 'x'.repeat(201) }, false);
  await T('chat: update', 'update', 'chat/m', U, { uid: 'alice', text: 'a' }, { uid: 'alice', text: 'b' }, false);
  await T('chat: delete не админ', 'delete', 'chat/m', U, {}, null, false);
  await T('chat: delete админ', 'delete', 'chat/m', ADM, {}, null, true);
  // неизвестное
  await T('неизвестная коллекция', 'read', 'secrets/x', ADM, {}, null, false);
  await T('flags: не для клиентов', 'read', 'flags/x', ADM, {}, null, false);
  await T('stats: не для клиентов', 'read', 'stats/x', ADM, {}, null, false);
  console.log('\nИтог: ' + ok + ' прошло, ' + bad + ' провалено'); process.exit(bad ? 1 : 0);
})();

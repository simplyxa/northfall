// Английская версия: перевод на лету того, что приходит готовым текстом с сервера или из сохранений
// (журнал рейда и дуэли, ответы сервера, названия вещей и зверей в старых данных, системные сообщения чата).
// Тексты игроков (чат, форум, письма, ники) не трогаем.
(function () {
  var D = __NAMES__;
  var P = [
    [/^Вышло обновление \((.+)\)\. Что нового — на форуме в теме «Обновления игры»\.$/, 'A new update is out ($1). See what\'s new on the forum in the «Game updates» topic.'],
    [/^🔥 К костру племени пришёл новый воин (.+)\. Поприветствуйте!$/, '🔥 A new warrior has come to the tribe\'s campfire: $1. Welcome them!'],
    [/^(.+) пал в бою\.$/, '$1 fell in battle.'],
    [/^Волна (\d+) из (\d+): бейте слуг всей группой!$/, 'Wave $1 of $2: fight the servants with the whole group!'],
    [/^Волна (\d+) из (\d+)!$/, 'Wave $1 of $2!'],
    [/^(\S+) (.+) выходит на группу! Бейте вместе\.$/, '$1 $2 comes at the group! Fight together.'],
    [/^(\S+) (.+) ждёт в глубине\. Сначала — (\d+) волны его слуг!$/, '$1 $2 waits in the depths. First — $3 waves of his servants!'],
    [/^(.+) повержен! Победа!$/, '$1 is defeated! Victory!'],
    [/^Вся группа пала\. Поражение\.$/, 'The whole group has fallen. Defeat.'],
    [/^Время вышло: (.+) уходит в глубину\. Поражение\.$/, 'Time is up: $1 retreats into the depths. Defeat.'],
    [/^(.+) оглушён и пропускает ход\.$/, '$1 is stunned and skips a turn.'],
    [/^(.+) поднимает щит\.$/, '$1 raises a shield.'],
    [/^(.+) пьёт бутылку: \+(\d+) здоровья\.$/, '$1 drinks a bottle: +$2 health.'],
    [/^(.+): «Исцеление духов» \+(\d+) здоровья\.$/, '$1: «Healing of the spirits» +$2 health.'],
    [/^(.+) принимает мощный удар на щит — (.+) оглушён!$/, '$1 takes a power strike on the shield — $2 is stunned!'],
    [/^(.+): мощный удар — (\d+)(.*)$/, '$1: power strike — $2$3'],
    [/^(.+): удар — (\d+)(.*)$/, '$1: strike — $2$3'],
    [/^Время вышло — побеждает тот, у кого больше здоровья\.$/, 'Time is up — whoever has more health wins.'],
    [/^Ничья!$/, 'Draw!'],
    [/^🏆 Победа: (.+)!$/, '🏆 Victory: $1!'],
    [/ \(крит!\)/g, ' (crit!)'], [/ \(в щит\)/g, ' (into the shield)'],
    [/^Передача вещи стоит (\d+) золото$/, 'Sending an item costs $1 gold'],
    [/^Сегодня можно обменять ещё (\d+) золота$/, 'You can exchange $1 more gold today'],
    [/^Сервер: /, 'Server: '],
    [/версии ([\d.]+)–([\d.]+)/g, 'versions $1–$2'], [/версия ([\d.]+)/g, 'version $1'],
    [/камень силы/g, 'gem of strength'], [/камень здоровья/g, 'gem of health'], [/камень брони/g, 'gem of armor'], [/камень регенерации/g, 'gem of regeneration'], [/камень энергии/g, 'gem of energy']
  ];
  var EX = {
    'Аккаунт слишком старый для подарка': 'The account is too old for this gift', 'Босс не найден': 'Boss not found', 'Вещи нет в рюкзаке': 'The item is not in the backpack',
    'Вещь уже забрали': 'The item has already been taken', 'Вещь уже купили, забери выручку': 'The item has already been bought, collect the proceeds', 'Войди в игру заново': 'Log in to the game again',
    'Восстановление пароля пока не настроено. Напиши на admin@playnorthfall.online.': 'Password recovery is not set up yet. Write to admin@playnorthfall.online.',
    'Дневной лимит золота за этого босса': 'Daily gold limit for this boss', 'Если к этому логину привязана почта, письмо со ссылкой уже отправлено. Проверь и папку «Спам».': 'If an email is linked to this login, a letter with a link has been sent. Check your «Spam» folder too.',
    'За этого босса золото не даётся': 'No gold is given for this boss', 'Золото за рейд — только если в группе от 3 живых воинов': 'Raid gold only if the group has 3 or more living warriors',
    'Игрок не найден': 'Player not found', 'Лот не найден': 'Listing not found', 'Магазин ещё не настроен': 'The shop is not set up yet', 'Мировой босс доступен с 25 уровня': 'The world boss is available from level 25',
    'Награда за Discord уже получена': 'The Discord reward has already been received', 'Награда уже получена': 'The reward has already been received', 'Не удалось отправить письмо. Попробуй позже.': 'Could not send the email. Try later.',
    'Не хватает железа': 'Not enough iron', 'Не хватает золота': 'Not enough gold', 'Не хватает серебра': 'Not enough silver', 'Неверная сумма': 'Invalid amount', 'Неверная цена': 'Invalid price',
    'Неверные данные': 'Invalid data', 'Неизвестное действие': 'Unknown action', 'Неизвестный пакет': 'Unknown package', 'Нет доступа': 'No access', 'Нет клана': 'No clan', 'Нет награды': 'No reward',
    'Ошибка сервера': 'Server error', 'Письмо не найдено': 'Letter not found', 'Подарок первой недели уже получен': 'The first-week gift has already been received', 'Подарок первой недели — на 7-й день игры': 'The first-week gift comes on day 7',
    'Подарок уже получен': 'The gift has already been received', 'Похоже, в почте ошибка.': 'Looks like there is a typo in the email.', 'Рейд не найден': 'Raid not found', 'Рюкзак полон': 'Backpack is full',
    'Только для администрации': 'Administration only', 'Это не твой лот': 'This is not your listing', 'Эту вещь нельзя передать': 'This item cannot be transferred', 'Эту вещь уже купили': 'This item has already been bought',
    'Обновления игры': 'Game updates', 'сбой': 'failure'
  };
  var CY = /[А-Яа-яЁё]/;
  var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var keys = Object.keys(D).sort(function (a, b) { return b.length - a.length; });
  var NRE = keys.length ? new RegExp('(^|[^А-Яа-яЁёA-Za-z])(' + keys.map(esc).join('|') + ')(?=$|[^А-Яа-яЁё])', 'g') : null;
  function tr(t) {
    if (!t || !CY.test(t)) return t;
    var s = t.trim();
    if (EX[s]) return t.replace(s, EX[s]);
    if (D[s]) return t.replace(s, D[s]);
    var hit = false;
    for (var i = 0; i < P.length; i++) { var re = P[i][0]; if (re.global) { re.lastIndex = 0; t = t.replace(re, P[i][1]); } else if (!hit && re.test(t)) { t = t.replace(re, P[i][1]); hit = true; } }
    if (NRE && CY.test(t)) t = t.replace(NRE, function (m, a, b) { return a + D[b]; });
    return t;
  }
  window.T = tr;
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, NOSCRIPT: 1 };
  var UGC = '.gcm,.ccm,.fpt,.ftop b,#dmbox,.ugc,[data-ugc]';
  function fix(n) {
    if (n.nodeType === 3) {
      var p = n.parentNode; if (!p || SKIP[p.nodeName]) return;
      if (!CY.test(n.nodeValue)) return;
      if (p.closest && p.closest(UGC)) return;
      var v = tr(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v;
      return;
    }
    if (n.nodeType !== 1 || SKIP[n.nodeName]) return;
    if (n.closest && n.closest(UGC)) return;
    var w = document.createTreeWalker(n, 4, null), x, L = [];
    while ((x = w.nextNode())) if (CY.test(x.nodeValue)) L.push(x);
    for (var i = 0; i < L.length; i++) fix(L[i]);
  }
  var mo = new MutationObserver(function (ms) {
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i];
      if (m.type === 'characterData') fix(m.target);
      else for (var j = 0; j < m.addedNodes.length; j++) fix(m.addedNodes[j]);
    }
  });
  function go() { fix(document.body); mo.observe(document.body, { subtree: true, childList: true, characterData: true }); }
  if (document.body) go(); else document.addEventListener('DOMContentLoaded', go);
  // всплывающие окна браузера тоже переводим
  var A = window.alert, C = window.confirm;
  window.alert = function (s) { return A.call(window, tr(String(s))); };
  window.confirm = function (s) { return C.call(window, tr(String(s))); };
})();

// Выпуск обновления: запись в changelog + версия в клиенте + пересборка EN.
//
// Запуск: node tools/release.js <версия> "<текст по-русски>" "<текст по-английски>"
//   node tools/release.js 1.18.1 "Пункт «Лагерь» теперь с многоточием." "The «Camp» item now has an ellipsis."
//
// Что делает:
//   1. дописывает запись {v, t, te} в netlify/lib/changelog.json;
//   2. поднимает GVER и подпись «Версия …» в public/index.html;
//   3. пересобирает английскую версию (node i18n/build_en.js).
//
// Зачем: после выкладки записи из changelog.json уходят на форум в тему
// «Обновления игры» (и «Game updates (English)») и в чат. Поэтому
// КАЖДОЕ обновление обязано иметь запись здесь — иначе игроки его не увидят.
// Правило живёт в DEVELOPMENT.md, раздел «Правило обновлений».
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');

const [ver, ru, en] = process.argv.slice(2);
if (!ver || !ru || !en) {
  console.error('Использование: node tools/release.js <версия> "<текст RU>" "<текст EN>"');
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+$/.test(ver)) { console.error('Версия должна быть вида 1.18.1'); process.exit(2); }

// 0. Проверка имён картинок: они кэшируются на год (immutable), поэтому имя
//    обязано быть хешем содержимого — иначе игроки останутся со старой графикой.
{
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'tools', 'assetcheck.js')], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('Проверка картинок не пройдена — выпуск остановлен.'); process.exit(2); }
}

// 1. changelog
const CL = path.join(ROOT, 'netlify', 'lib', 'changelog.json');
const log = JSON.parse(fs.readFileSync(CL, 'utf8'));
if (log.some(x => x.v === ver)) { console.error('Версия ' + ver + ' уже есть в changelog.json'); process.exit(2); }
log.push({ v: ver, t: ru, te: en });
fs.writeFileSync(CL, JSON.stringify(log, null, 1) + '\n');
console.log('changelog.json: добавлена запись ' + ver);

// 2. версия в клиенте
const CLI = path.join(ROOT, 'public', 'index.html');
let html = fs.readFileSync(CLI, 'utf8');
const m = html.match(/const GVER='([\d.]+)'/);
if (!m) { console.error('Не нашёл GVER в клиенте'); process.exit(2); }
if (m[1] === ver) { console.log('версия в клиенте уже ' + ver); }
else {
  html = html.replace(/const GVER='[\d.]+'/, "const GVER='" + ver + "'");
  html = html.replace(/Версия [\d.]+/g, 'Версия ' + ver);
  fs.writeFileSync(CLI, html);
  console.log('клиент: версия ' + m[1] + ' → ' + ver);
}

// 3. английская версия
const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'i18n', 'build_en.js')], { stdio: 'inherit' });
if (r.status !== 0) { console.error('сборка EN не удалась'); process.exit(1); }

console.log('\nГотово. Запись ' + ver + ' уедет на форум при следующей выкладке.');
console.log('Ссылки на темы обновлений:');
console.log('  RU: https://playnorthfall.online/?go=forum&t=tupdates');
console.log('  EN: https://playnorthfall.online/en/?go=forum&t=tupdates_en');

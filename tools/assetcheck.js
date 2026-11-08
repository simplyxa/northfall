// Проверка имён картинок: кэш браузера на картинках держится год (immutable),
// поэтому имя файла обязано быть хешем содержимого. Иначе игрок после
// обновления видит старую графику (именно так сломалась охота в 1.18.6).
//
// Запуск: node tools/assetcheck.js
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const dir = path.join(ROOT, 'public', 'img');

const bad = [];
for (const n of fs.readdirSync(dir).sort()) {
  if (!/^[0-9a-f]{14}\.webp$/.test(n)) { bad.push(n + ' (имя не по конвенции)'); continue; }
  const h = crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, n))).digest('hex').slice(0, 14);
  if (h !== n.slice(0, 14)) bad.push(n + ' (хеш не сходится: ' + h + ')');
}

// ссылки в клиенте на несуществующие картинки
const cli = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const missing = new Set();
for (const m of cli.matchAll(/\/img\/([A-Za-z0-9._-]+\.webp)/g)) {
  if (!fs.existsSync(path.join(dir, m[1]))) missing.add(m[1]);
}

if (bad.length || missing.size) {
  console.error('Проверка картинок не пройдена:');
  if (bad.length) { console.error('  неверное имя (нужно <sha1 содержимого>.webp):'); bad.forEach(x => console.error('    ' + x)); }
  if (missing.size) { console.error('  в клиенте есть ссылки на несуществующие файлы:'); [...missing].forEach(x => console.error('    ' + x)); }
  process.exit(1);
}
console.log('картинки: имена по хешу содержимого, все ссылки клиента на месте ✓');

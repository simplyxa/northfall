// Собирает английскую версию public/en/index.html из русской public/index.html по словарю i18n/en.json.
'use strict';
const fs = require('fs'), path = require('path');
const { scan, CYR } = require('./scan.js');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, 'en.json'), 'utf8'));
// ключи с номером версии ищем без номера
const VRE = /\d+\.\d+\.\d+/g, ENV = {};
for (const [k, v] of Object.entries(EN)) if (VRE.test(k)) { VRE.lastIndex = 0; ENV[k.replace(VRE, '#V#')] = v; }
function look(k) {
  if (EN[k] != null) return EN[k];
  const kv = k.replace(VRE, '#V#'); VRE.lastIndex = 0;
  if (ENV[kv] != null) { const vs = k.match(VRE) || []; let i = 0; return ENV[kv].replace(VRE, () => vs[i++] || ''); }
  return null;
}
const U = scan(html), miss = new Map();
let out = '', pos = 0, n = 0;
for (const u of U) {
  let en = look(u.key);
  if (en == null) { miss.set(u.key, (miss.get(u.key) || 0) + 1); continue; }
  en = en.replace(/«/g, '“').replace(/»/g, '”');
  let rep;
  if (u.kind === 'str') rep = u.q + en.replace(/\\/g, '\\\\').replace(new RegExp(u.q, 'g'), '\\' + u.q).replace(/\n/g, '\\n').replace(new RegExp("\\u2028","g"), '\\u2028') + u.q;
  else if (u.kind === 'tpl') rep = en.replace(/\\(?![`$])/g, '\\\\').replace(/(^|[^\\])`/g, '$1\\`').replace(/(^|[^\\])\$\{/g, '$1\\${');
  else if (u.kind === 'json') rep = JSON.stringify(en);
  else if (u.kind === 'attr') rep = en.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  else rep = en;
  out += html.slice(pos, u.s) + rep; pos = u.e; n++;
}
out += html.slice(pos);
// язык страницы, даты и числа, английское множественное число, адреса
out = out.replace('<html lang="ru">', '<html lang="en">')
  .replace(/'ru-RU'/g, "'en-GB'")
  .replace(/([A-Za-z_$][\w$.]*)%10===1&&\1%100!==11\?/g, '$1===1?')
  .replace(/<link rel="manifest" href="\/manifest\.webmanifest">/, '<link rel="manifest" href="/manifest.en.webmanifest">')
  .replace(/(<link rel="canonical" href="https:\/\/playnorthfall\.online)\/?"/, '$1/en/"')
  .replace(/(<meta property="og:url" content="https:\/\/playnorthfall\.online)\/?"/, '$1/en/"')
  .replace(/<meta property="og:locale" content="ru_RU">/, '<meta property="og:locale" content="en_US">');
// кнопка «В БОЙ» нарисована по-русски — в английской версии обычная кнопка
out = out.replace('<button class="vboi" data-a="gmk" aria-label="To battle!"><img src="${VBOI}" alt="To battle!"></button>', '<button class="b red vben" data-a="gmk" style="width:100%;font-size:24px;letter-spacing:.06em;padding:18px;margin:6px 0 10px;font-weight:700">⚔ TO BATTLE!</button>');
// словарь имён для перевода на лету: короткие названия без разметки
const NAMES = {};
for (const [k, v] of Object.entries(EN)) if (k.length >= 3 && k.length <= 40 && !/[<>"=\n{}]/.test(k) && /^[А-ЯЁ]/.test(k) && k.trim() === k && !/[.!?:]$/.test(k)) NAMES[k] = v;
const rt = fs.readFileSync(path.join(__dirname, 'rt_en.js'), 'utf8').replace('__NAMES__', JSON.stringify(NAMES));
out = out.replace('<head>', '<head>\n<script>window.NF_LANG=\'en\';</script>');
out = out.replace('</body>', '<script>' + rt + '</script>\n</body>');
const ALT = '<link rel="alternate" hreflang="ru" href="https://playnorthfall.online/"><link rel="alternate" hreflang="en" href="https://playnorthfall.online/en/"><link rel="alternate" hreflang="x-default" href="https://playnorthfall.online/">';
out = out.replace('</head>', ALT + '\n</head>');
if (!html.includes('hreflang="en"')) fs.writeFileSync(path.join(ROOT, 'public/index.html'), html.replace('</head>', ALT + '\n</head>'));
const smp = path.join(ROOT, 'public/sitemap.xml'); let sm = fs.readFileSync(smp, 'utf8');
if (!sm.includes('/en/</loc>')) fs.writeFileSync(smp, sm.replace('</urlset>', '  <url>\n    <loc>https://playnorthfall.online/en/</loc>\n    <changefreq>daily</changefreq>\n    <priority>0.9</priority>\n  </url>\n</urlset>'));
fs.mkdirSync(path.join(ROOT, 'public/en'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'public/en/index.html'), out);
// английский манифест
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.webmanifest'), 'utf8'));
Object.assign(man, { description: 'A browser RPG about the barbarians of the North: hunting, clans, dungeons and world bosses.', lang: 'en', start_url: '/en/?app=1', id: '/en/' });
fs.writeFileSync(path.join(ROOT, 'public/manifest.en.webmanifest'), JSON.stringify(man, null, 2) + '\n');
const left = (out.match(/[А-Яа-яЁё]+/g) || []).length;
console.log(`EN: replaced ${n}/${U.length}, missing ${miss.size} unique; cyrillic words left ${left}; names ${Object.keys(NAMES).length}`);
if (miss.size) { const f = path.join(__dirname, 'missing.json'); fs.writeFileSync(f, JSON.stringify([...miss.keys()], null, 1)); console.log('missing list → i18n/missing.json'); }

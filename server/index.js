// Northfall: свой сервер (Fly.io). Шаг 0 переезда с Netlify.
// Делает то же, что Netlify: раздаёт public/, выполняет функции из netlify/functions
// по тем же адресам (/.netlify/functions/<имя>), запускает рассылку по расписанию
// и после старта публикует список изменений (как deploy-succeeded).
// Firebase пока остаётся: вход и данные работают как раньше.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { makeLimiter } = require('./ratelimit');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const FN = path.join(ROOT, 'netlify', 'functions');
const PORT = +process.env.PORT || 8080;
const MAXBODY = 1 << 20; // 1 МБ — больше функциям не нужно

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4'
};
const ZIP = /^(text\/|application\/(json|manifest|xml|javascript)|image\/svg)/;

// кэш как в netlify.toml
function cacheFor(rel) {
  if (rel.startsWith('/img/')) return 'public, max-age=31536000, immutable';
  if (rel === '/' || rel === '/index.html' || rel === '/sw.js' || rel === '/manifest.webmanifest' || rel === '/en/' || rel === '/en/index.html' || rel === '/manifest.en.webmanifest') return 'no-cache';
  return 'public, max-age=3600';
}
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000'
};

// файлы читаем один раз и держим в памяти вместе со сжатыми копиями (сайт маленький)
const FILES = new Map();
function file(rel) {
  if (FILES.has(rel)) return FILES.get(rel);
  const abs = path.join(PUB, rel);
  if (!abs.startsWith(PUB + path.sep) && abs !== PUB) return null;
  let st; try { st = fs.statSync(abs); } catch (e) { return null; }
  if (!st.isFile()) return null;
  const buf = fs.readFileSync(abs), type = TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const f = { buf, type, etag: '"' + crypto.createHash('sha1').update(buf).digest('base64').slice(0, 20) + '"' };
  if (ZIP.test(type) && buf.length > 1024) { f.br = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }); f.gz = zlib.gzipSync(buf, { level: 9 }); }
  FILES.set(rel, f);
  return f;
}

function sendStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel.includes('\0') || rel.includes('..')) return notFound(res);
  if (rel === '/en') { res.writeHead(301, { ...SEC, Location: '/en/' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '') }); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  let f = file(rel);
  if (!f && !path.extname(rel)) { f = file(rel + '.html') || file(rel + '/index.html'); }
  if (!f) return notFound(res);
  const h = { ...SEC, 'Content-Type': f.type, 'Cache-Control': cacheFor(urlPath === '/' ? '/' : rel), ETag: f.etag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, h); return res.end(); }
  const ae = req.headers['accept-encoding'] || '';
  let body = f.buf;
  if (f.br && /\bbr\b/.test(ae)) { body = f.br; h['Content-Encoding'] = 'br'; }
  else if (f.gz && /\bgzip\b/.test(ae)) { body = f.gz; h['Content-Encoding'] = 'gzip'; }
  h['Content-Length'] = body.length;
  res.writeHead(200, h);
  res.end(req.method === 'HEAD' ? undefined : body);
}
function notFound(res) {
  res.writeHead(404, { ...SEC, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Не найдено');
}

// функции Netlify: тот же формат event/ответа, код функций не меняется
const HANDLERS = {};
function handler(name) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  if (name in HANDLERS) return HANDLERS[name];
  const p = path.join(FN, name + '.js');
  HANDLERS[name] = fs.existsSync(p) ? require(p).handler : null;
  return HANDLERS[name];
}
async function runFn(name, event) {
  const h = handler(name);
  if (!h) return { statusCode: 404, body: 'no function' };
  return (await h(event, {})) || { statusCode: 200, body: '' };
}

function readBody(req) {
  return new Promise((ok, bad) => {
    const ch = []; let n = 0;
    req.on('data', d => { n += d.length; if (n > MAXBODY) { bad(new Error('too big')); req.destroy(); } else ch.push(d); });
    req.on('end', () => ok(Buffer.concat(ch)));
    req.on('error', bad);
  });
}

// IP клиента: на Fly.io прокси ставит fly-client-ip
function clientIp(req) {
  const h = req.headers;
  return String(h['fly-client-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();
}
// Мусорный трафик (без токена) режем по IP: он всё равно будет отклонён проверкой токена,
// но не должен занимать сервер. Авторизованных по IP не режем — за одним CGNAT может быть
// много игроков, их режем по uid внутри saves.js.
const LIM_NOAUTH = makeLimiter({ cap: 20, perSec: 20 / 60 });
function noAuthLimit(req, res) {
  if (req.headers.authorization) return true;
  const ip = clientIp(req) || 'unknown';
  if (LIM_NOAUTH(ip)) return true;
  res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(LIM_NOAUTH.retryAfter(ip)) });
  res.end(JSON.stringify({ error: 'Слишком частые запросы' }));
  return false;
}

async function fnRoute(req, res, u, name) {
  if (name === 'push-cron' || name === 'deploy-succeeded') return notFound(res); // только изнутри сервера
  let raw;
  try { raw = await readBody(req); } catch (e) { res.writeHead(413); return res.end(); }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  const ip = clientIp(req);
  if (ip) { headers['x-nf-client-connection-ip'] = ip; headers['client-ip'] = ip; }
  const event = {
    httpMethod: req.method, path: u.pathname, rawUrl: 'https://' + (headers.host || 'localhost') + u.pathname + u.search,
    headers, queryStringParameters: Object.fromEntries(u.searchParams), body: raw.toString('utf8'), isBase64Encoded: false
  };
  let r;
  try { r = await runFn(name, event); }
  catch (e) { console.error('fn', name, e); r = { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Ошибка сервера' }) }; }
  if (name !== 'track') console.log('fn', name, r.statusCode || 200, (r.statusCode || 200) >= 400 ? String(r.body || '').slice(0, 160) : '');
  const out = r.isBase64Encoded ? Buffer.from(r.body || '', 'base64') : Buffer.from(r.body == null ? '' : String(r.body));
  res.writeHead(r.statusCode || 200, { ...SEC, 'Cache-Control': 'no-store', ...(r.headers || {}), 'Content-Length': out.length });
  res.end(out);
}

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  // единый адрес: www → без www
  const host = (req.headers.host || '').toLowerCase();
  if (host.startsWith('www.')) { res.writeHead(301, { Location: 'https://' + host.slice(4) + req.url }); return res.end(); }
  if (u.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (u.pathname === '/hubz') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(HUB.stats())); }
  if (u.pathname === '/api/flags') return SAVE.flags(req, res).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
  if (u.pathname === '/api/op' && req.method === 'POST') {
    if (!noAuthLimit(req, res)) return;
    let b; try { b = await readBody(req); } catch (e) { res.writeHead(413); return res.end(); }
    return SAVE.op(req, res, b).catch(e => { console.error('op', e); if (!res.headersSent) { res.writeHead(500); res.end(); } });
  }
  if (u.pathname === '/api/save' && req.method === 'POST') {
    if (!noAuthLimit(req, res)) return;
    let b; try { b = await readBody(req); } catch (e) { res.writeHead(413); return res.end(); }
    return SAVE(req, res, b).catch(e => { console.error('save', e); if (!res.headersSent) { res.writeHead(500); res.end(); } });
  }
  const m = u.pathname.match(/^\/(?:\.netlify\/functions|api)\/([a-z0-9-]+)\/?$/);
  if (m) return fnRoute(req, res, u, m[1]);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  sendStatic(req, res, u.pathname);
});
server.keepAliveTimeout = 65000;
// firebase-admin: без ключа в окружении работаем как «без базы» (проверки/статика)
const fbAdmin = () => { if (!process.env.FIREBASE_SERVICE_ACCOUNT) return null; const a = require('../netlify/lib/fb'); return a.initErr && a.initErr() ? null : a; };
const SAVE = require('./saves')(() => fbAdmin());
// сокет-хаб: живые списки и «онлайн» по WebSocket (/ws)
const HUB = require('./hub')(server, () => { const a = fbAdmin(); return a ? a.firestore() : null; }, async tok => {
  const a = fbAdmin(); if (!a) throw new Error('no firebase');
  const d = await a.auth().verifyIdToken(tok), DOM = '@northfall.game';
  if (!d.email || !d.email.endsWith(DOM)) throw new Error('bad user');
  return d.email.slice(0, -DOM.length);
});
server.listen(PORT, () => console.log('Northfall server on :' + PORT));

// расписание: push-cron каждые 15 минут (по границе :00/:15/:30/:45, как в Netlify)
let cronBusy = false;
async function cron() {
  if (cronBusy || !process.env.FIREBASE_SERVICE_ACCOUNT) return;
  cronBusy = true;
  try { const r = await runFn('push-cron', { httpMethod: 'POST', headers: {}, body: '' }); console.log('push-cron', r && r.statusCode, (r && r.body || '').slice(0, 120)); }
  catch (e) { console.error('push-cron', e); }
  cronBusy = false;
}
function nextQuarter() { const q = 15 * 60000; return q - (Date.now() % q) + 2000; }
if (process.env.CRON !== 'off') (function loop() { setTimeout(() => { cron().finally(loop); }, nextQuarter()); })();

// после старта новой версии — список изменений на форум (повторы функция сама отсекает)
if (process.env.FIREBASE_SERVICE_ACCOUNT && process.env.CHANGELOG !== 'off') {
  setTimeout(() => runFn('deploy-succeeded', { httpMethod: 'POST', headers: {}, body: JSON.stringify({ payload: { context: 'production' } }) })
    .then(r => console.log('changelog', r && r.statusCode, r && r.body)).catch(e => console.error('changelog', e)), 15000);
}

process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); });
process.on('unhandledRejection', e => console.error('unhandled', e));

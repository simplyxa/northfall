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
  if (rel === '/' || rel === '/index.html' || rel === '/sw.js' || rel === '/manifest.webmanifest' || rel === '/en/' || rel === '/en/index.html' || rel === '/manifest.en.webmanifest' || rel === '/version.json') return 'no-cache';
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
  if (u.pathname === '/api/admin-clan' && req.method === 'POST') {
    if (!noAuthLimit(req, res)) return;
    let b; try { b = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'bad_json' })); }
    try {
      const a = fbAdmin(); if (!a) { res.writeHead(503); return res.end(JSON.stringify({ error: 'firebase_unavailable' })); }
      const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const user = await a.auth().verifyIdToken(tok);
      const email = String(user.email || '').toLowerCase();
      const uid = email.endsWith('@northfall.game') ? email.slice(0, -'@northfall.game'.length) : '';
      if (!['shtorm1', 'admin'].includes(uid)) { res.writeHead(403); return res.end(JSON.stringify({ error: 'forbidden' })); }
      const id = String(b.id || '');
      if (!/^[a-z0-9_]{3,32}$/i.test(id)) { res.writeHead(400); return res.end(JSON.stringify({ error: 'bad_clan_id' })); }
      const db = a.firestore(), ref = db.collection('clans').doc(id), snap = await ref.get();
      if (!snap.exists) { res.writeHead(404); return res.end(JSON.stringify({ error: 'clan_not_found' })); }
      const clan = snap.data() || {};
      const members = new Set([...(Array.isArray(clan.mem) ? clan.mem : []), ...(Array.isArray(clan.members) ? clan.members : []), clan.leader].filter(x => typeof x === 'string' && x));
      for (const col of ['players', 'saves']) {
        const qs = await db.collection(col).where('clan', '==', id).get();
        for (let i = 0; i < qs.docs.length; i += 400) {
          const batch = db.batch();
          qs.docs.slice(i, i + 400).forEach(d => batch.set(d.ref, { clan: '', cjt: a.firestore.FieldValue.delete() }, { merge: true }));
          await batch.commit();
        }
      }
      await db.recursiveDelete(ref);
      console.log('admin clan deleted', id, 'members', members.size, 'by', uid);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, id, name: String(clan.name || id), members: members.size }));
    } catch (e) {
      console.error('admin-clan', e.message);
      const status = e.code === 'auth/id-token-expired' || e.code === 'auth/argument-error' ? 401 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: status === 401 ? 'auth_required' : 'delete_failed' }));
    }
  }
  if (u.pathname === '/api/admin-live-ranking' && (req.method === 'GET' || req.method === 'POST')) {
    if (!noAuthLimit(req, res)) return;
    try {
      const a = fbAdmin(); if (!a) { res.writeHead(503); return res.end(JSON.stringify({ error: 'firebase_unavailable' })); }
      const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const user = await a.auth().verifyIdToken(tok);
      const email = String(user.email || '').toLowerCase();
      const adminId = email.endsWith('@northfall.game') ? email.slice(0, -'@northfall.game'.length) : '';
      if (!['shtorm1', 'admin'].includes(adminId)) { res.writeHead(403); return res.end(JSON.stringify({ error: 'forbidden' })); }
      const db = a.firestore();
      if (req.method === 'GET') {
        const ss = await db.collection('saves').limit(1500).get(), candidates = [];
        for (let i = 0; i < ss.docs.length; i += 100) {
          const group = ss.docs.slice(i, i + 100);
          const ps = await db.getAll(...group.map(d => db.collection('players').doc(d.id)));
          for (let j = 0; j < group.length; j++) {
            const sv = group[j].data() || {}, pv = ps[j].exists ? ps[j].data() || {} : null;
            if (!sv.name || !Number.isFinite(+sv.lvl)) continue;
            const keys = ['rating','srat','dr','dn','dw'];
            const missing = !pv;
            const changed = pv && keys.some(k => (pv[k] == null ? 0 : +pv[k]) !== (sv[k] == null ? 0 : +sv[k]));
            if (missing || changed) candidates.push({
              id: group[j].id, name: String(sv.name).slice(0,40), lvl: sv.lvl|0,
              missing, rating: sv.rating|0, dr: sv.dr==null?1000:sv.dr|0, dn: sv.dn|0, dw: sv.dw|0,
              reason: missing ? 'Карточка отсутствует' : 'Рейтинг отличается от сохранения'
            });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ ok:true, scanned:ss.size, candidates }));
      }
      let b; try { b = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error:'bad_json' })); }
      const id = String(b.id || '');
      if (!/^[a-z0-9_]{3,32}$/i.test(id)) { res.writeHead(400); return res.end(JSON.stringify({ error:'bad_player_id' })); }
      const sr = db.collection('saves').doc(id), pr = db.collection('players').doc(id);
      const sn = await sr.get(); if (!sn.exists) { res.writeHead(404); return res.end(JSON.stringify({ error:'save_not_found' })); }
      const sv = sn.data() || {};
      if (!sv.name || !Number.isFinite(+sv.lvl) || !sv.inv || !Array.isArray(sv.inv)) { res.writeHead(409); return res.end(JSON.stringify({ error:'save_not_eligible' })); }
      const card = {
        name:sv.name, cls:sv.cls||'', lvl:sv.lvl|0, rating:sv.rating|0, srat:sv.srat|0,
        sid:sv.sid|0, psid:sv.psid|0, psrat:sv.psrat|0, win:sv.win|0, lose:sv.lose|0,
        dr:sv.dr==null?1000:sv.dr|0, dn:sv.dn|0, dw:sv.dw|0,
        clan:sv.clan||'', war:sv.war||'', wp:sv.wp|0, av:sv.av||{s:0,c:0},
        title:sv.title||'', ssum:sv.ssum|0, seen:sv.ts||Date.now(),
        eq:sv.eq||{}, stats:sv.stats||{}, ex:sv.ex&&sv.ex.end?+sv.ex.end:0,
        cxt:sv.cxt|0, reg:sv.reg||0, rd:sv.rd==null?null:sv.rd, old:sv.old?1:0,
        src:sv.src||'', act:Array.isArray(sv.act)?sv.act.slice(-40):[],
        app:sv.app?1:0, appEver:sv.appEver?1:0, cnt:sv.cnt||{}, xpt:sv.xpt|0, cjt:sv.cjt|0
      };
      await pr.set(card, { merge:true });
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
      return res.end(JSON.stringify({ok:true,id,name:sv.name,dr:card.dr,dn:card.dn,dw:card.dw,rating:card.rating}));
    } catch (e) {
      console.error('admin-live-ranking', e.message);
      const status = e.code === 'auth/id-token-expired' || e.code === 'auth/argument-error' ? 401 : 500;
      res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify({error:status===401?'auth_required':'recovery_failed'}));
    }
  }
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

// Уборка тестовых карточек.
// tools/rulecheck.js заходит временным игроком и проверяет правила Firestore,
// поэтому на пару секунд появляется карточка с префиксом zz_. Если тест не
// успел её удалить (например, правила не пускали удалять), она оставалась
// в рейтинге и в админке. Сервер подметает такие карточки сам.
//   • по имени — при старте (раз в деплой, коллекция маленькая);
//   • по маркеру tst — каждые 2 минуты (запрос по индексу, дёшево).
const TEST_ID = /^zz_/;
async function sweepTestCards(full) {
  const a = fbAdmin(); if (!a) return;
  const db = a.firestore();
  try {
    if (full) {
      const snap = await db.collection('players').get();
      const bad = snap.docs.filter(d => TEST_ID.test(d.id));
      for (const d of bad) await d.ref.delete();
      if (bad.length) console.log('sweep: удалено тестовых карточек', bad.length);
    }
    const mark = await db.collection('players').where('tst', '==', 1).get();
    for (const d of mark.docs) await d.ref.delete();
    if (!mark.empty) console.log('sweep: удалено карточек с маркером', mark.size);
  } catch (e) { console.error('sweep', e.message); }
}

// после старта новой версии — список изменений на форум (повторы функция сама отсекает)
// уборка тестовых карточек: при старте — по имени, потом раз в 15 минут — по маркеру
sweepTestCards(true);
setTimeout(() => { sweepTestCards(false); setInterval(() => sweepTestCards(false), 2 * 60000).unref(); }, 20000);

if (process.env.FIREBASE_SERVICE_ACCOUNT && process.env.CHANGELOG !== 'off') {
  setTimeout(() => runFn('deploy-succeeded', { httpMethod: 'POST', headers: {}, body: JSON.stringify({ payload: { context: 'production' } }) })
    .then(r => console.log('changelog', r && r.statusCode, r && r.body)).catch(e => console.error('changelog', e)), 15000);
}

process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); });
process.on('unhandledRejection', e => console.error('unhandled', e));

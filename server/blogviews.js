// Счётчик просмотров статей блога (/blog/). Один человек за сутки засчитывается один раз на статью.
// Хранение: таблица blog_views в Postgres (создаётся при первом обращении); без DATABASE_URL — в памяти (до перезапуска).
// Личные данные не храним: только хэш (ip+браузер+соль на сутки), по нему нельзя вернуться к человеку.
'use strict';
const crypto = require('crypto');
const pg = require('./pg');

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|curl|wget|python|node-fetch|monitor|uptime|soro/i;
const mem = new Map();           // k -> Set(vh+day)
let ready = null;

function ensure() {
  if (!pg.enabled()) return Promise.resolve(false);
  if (!ready) ready = pg.query('CREATE TABLE IF NOT EXISTS blog_views (k TEXT NOT NULL, vh TEXT NOT NULL, day DATE NOT NULL DEFAULT CURRENT_DATE, created TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (k, vh, day))')
    .then(() => true).catch(e => { ready = null; console.error('blogviews init:', e.code || e.message); return false; });
  return ready;
}
const cleanKey = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
const day = () => new Date().toISOString().slice(0, 10);

async function count(k) {
  if (await ensure()) { const r = await pg.query('SELECT count(*)::int AS n FROM blog_views WHERE k=$1', [k]); return r.rows[0].n; }
  return (mem.get(k) || new Set()).size;
}
async function add(k, vh) {
  if (await ensure()) { await pg.query('INSERT INTO blog_views (k, vh) VALUES ($1,$2) ON CONFLICT DO NOTHING', [k, vh]); return; }
  if (!mem.has(k)) mem.set(k, new Set());
  mem.get(k).add(vh + day());
}

// GET /api/bv?k=Заголовок — число просмотров; POST /api/bv {k} — засчитать просмотр и вернуть число
async function handle(req, res, u, ip, readBody) {
  const J = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  try {
    let k;
    if (req.method === 'POST') {
      let b = {}; try { b = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch (e) { return J(400, { error: 'bad_json' }); }
      k = cleanKey(b.k);
      if (!k) return J(400, { error: 'no_key' });
      const ua = String(req.headers['user-agent'] || '');
      if (ua && !BOT.test(ua)) {
        const vh = crypto.createHash('sha256').update(ip + '|' + ua + '|' + day() + '|nfblog').digest('hex').slice(0, 24);
        await add(k, vh);
      }
    } else { k = cleanKey(u.searchParams.get('k')); if (!k) return J(400, { error: 'no_key' }); }
    return J(200, { n: await count(k) });
  } catch (e) { console.error('blogviews:', e.code || e.message); return J(503, { error: 'unavailable' }); }
}
module.exports = { handle };

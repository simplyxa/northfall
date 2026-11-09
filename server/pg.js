// PostgreSQL (Neon) — изолированный ленивый пул. Игровые маршруты его НЕ используют.
// Подключение создаётся только если задан DATABASE_URL; без него сервер работает как раньше.
// Строка подключения — секрет: хранить только в Fly secrets, не логировать, не коммитить.
// Для долгоживущего приложения нужен pooled-адрес Neon (хост содержит -pooler).
'use strict';

let pool = null, loadErr = null;

function enabled() { return !!process.env.DATABASE_URL; }

function getPool() {
  if (!enabled()) return null;
  if (pool) return pool;
  let Pool;
  try { ({ Pool } = require('pg')); } catch (e) { loadErr = e; console.error('pg: драйвер не установлен (npm install)'); return null; }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Math.max(1, Math.min(10, Number(process.env.PG_POOL_MAX) || 3)),   // машина Fly — 256 МБ
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: Math.max(1000, Number(process.env.PG_CONN_TIMEOUT_MS) || 5000),
    statement_timeout: 15000,
    ssl: { rejectUnauthorized: true }      // TLS обязателен, проверку сертификата не отключаем
  });
  // ошибка простаивающего соединения не должна валить процесс
  pool.on('error', e => console.error('pg pool:', e.code || e.message));
  return pool;
}

async function query(text, params) {
  const p = getPool();
  if (!p) throw new Error('pg_disabled');
  return p.query(text, params);
}

// транзакция: fn(client) → результат; ROLLBACK при любой ошибке
async function tx(fn) {
  const p = getPool();
  if (!p) throw new Error('pg_disabled');
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (e2) {}
    throw e;
  } finally { c.release(); }
}

// Диагностика для администратора: без деталей подключения и текста ошибок БД.
async function smoke() {
  if (!enabled()) return { ok: false, why: 'disabled' };
  if (!getPool()) return { ok: false, why: 'driver_missing' };
  try {
    const t0 = Date.now();
    await query('SELECT 1 AS ok');
    const r = await query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'");
    return { ok: true, tables: r.rows[0].n, ms: Date.now() - t0 };
  } catch (e) { return { ok: false, why: 'query_failed', code: e.code || null }; }
}

async function close() {
  if (!pool) return;
  const p = pool; pool = null;
  try { await p.end(); } catch (e) {}
}

module.exports = { enabled, getPool, query, tx, smoke, close };

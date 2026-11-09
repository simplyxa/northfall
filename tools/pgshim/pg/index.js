// ТОЛЬКО ДЛЯ ЛОКАЛЬНЫХ ТЕСТОВ без доступа к npm: имитирует драйвер `pg` через постоянные процессы psql.
// Подключение: NODE_PATH=tools/pgshim  PGSHIM_ARGS="-h /путь -p 5439 -U postgres -d nf"
// В боевом коде и в CI используется настоящий пакет pg.
'use strict';
const { spawn } = require('child_process');
const lit = v => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return "'{" + v.map(x => '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + "}'";
  if (v instanceof Date) v = v.toISOString();
  return "'" + String(v).replace(/'/g, "''") + "'";
};
class Client {
  constructor() {
    const a = (process.env.PGSHIM_ARGS || '').split(' ').filter(Boolean).map(x => "'" + x + "'").join(' ');
    this.p = spawn('sh', ['-c', 'exec psql -X -q -A -t -v ON_ERROR_STOP=0 -v VERBOSITY=sqlstate ' + a + ' 2>&1'], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buf = ''; this.wait = null; this.q = Promise.resolve();
    this.p.stdout.on('data', d => { this.buf += d; this._check(); });
    this.p.stdin.write('\\set VERBOSITY sqlstate\n');
  }
  _check() { if (!this.wait) return; const i = this.buf.indexOf(this.wait.mark + '\n'); if (i < 0) return; const out = this.buf.slice(0, i); this.buf = this.buf.slice(i + this.wait.mark.length + 1); const w = this.wait; this.wait = null; w.res(out); }
  query(text, params) {
    const run = this.q.catch(() => {}).then(() => new Promise((res, rej) => {
      let sql = text.replace(/\$(\d+)/g, (m, n) => lit((params || [])[n - 1]));
      const isSel = /^\s*SELECT/i.test(sql);
      if (isSel) sql = 'SELECT coalesce(jsonb_agg(to_jsonb(q)), \'[]\'::jsonb) FROM (' + sql + ') q';
      const mark = '__END' + Math.random().toString(36).slice(2) + '__';
      this.wait = { mark, res: out => {
        const m = out.match(/^ERROR:\s+([0-9A-Z]{5})/m);
        if (m) { const e = new Error('pgshim ' + m[1] + ': ' + out.trim().slice(0, 200)); e.code = m[1]; return rej(e); }
        if (isSel) { const line = out.trim().split('\n').filter(Boolean).pop(); return res({ rows: JSON.parse(line || '[]') }); }
        res({ rows: [] });
      } };
      this.p.stdin.write(sql + ';\n\\echo ' + mark + '\n');
    }));
    this.q = run; return run;
  }
  release() { this.pool && this.pool._free(this); }
}
class Pool {
  constructor(o) { this.max = (o && o.max) || 3; this.all = []; this.idle = []; this.waiters = []; }
  on() {}
  async connect() {
    if (this.idle.length) return this.idle.pop();
    if (this.all.length < this.max) { const c = new Client(); c.pool = this; this.all.push(c); return c; }
    return new Promise(r => this.waiters.push(r));
  }
  _free(c) { const w = this.waiters.shift(); if (w) w(c); else this.idle.push(c); }
  async query(t, p) { const c = await this.connect(); try { return await c.query(t, p); } finally { c.release(); } }
  async end() { for (const c of this.all) c.p.stdin.end(); this.all = []; this.idle = []; }
}
module.exports = { Pool };

// Слой, совместимый по интерфейсу с firebase-admin Firestore, поверх PostgreSQL (Neon).
// Включается переменной STORE=pg (см. netlify/lib/fb.js). Игровой код не меняется: collection/doc/get/set/update/
// delete/create, where/orderBy/limit/startAfter/count, runTransaction (блокировки строк), batch, getAll,
// FieldValue (delete/increment/serverTimestamp/arrayUnion/arrayRemove), onSnapshot (опрос), collectionGroup.
// Хранилище: таблица fs_docs (db/migrations/0004_fs_docs.sql).
'use strict';
const pg = require('./pg');
const bus = new (require('events'))(); bus.setMaxListeners(0);   // «в базу что-то записано» — подписки обновляются сразу, не ждут опроса

// ---------- спец-значения ----------
class Sentinel { constructor(kind, v) { this.kind = kind; this.v = v; } }
const FieldValue = {
  delete: () => new Sentinel('delete'),
  increment: n => new Sentinel('inc', Number(n)),
  serverTimestamp: () => new Sentinel('ts'),
  arrayUnion: (...a) => new Sentinel('union', a),
  arrayRemove: (...a) => new Sentinel('remove', a)
};
const FieldPath = { documentId: () => '__name__' };
const NAME = '__name__';

function fsErr(code, msg) { const e = new Error(msg); e.code = code; return e; }   // 5 NOT_FOUND, 6 ALREADY_EXISTS
const isObj = v => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Sentinel) && !(v instanceof Date);
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// применяет значение-«команду» к существующему
function resolveValue(v, old) {
  if (v instanceof Sentinel) {
    if (v.kind === 'inc') return (typeof old === 'number' ? old : 0) + v.v;
    if (v.kind === 'ts') return Date.now();
    if (v.kind === 'union') { const a = Array.isArray(old) ? old.slice() : []; for (const x of v.v) if (!a.some(y => eq(x, y))) a.push(clone(x)); return a; }
    if (v.kind === 'remove') return (Array.isArray(old) ? old : []).filter(y => !v.v.some(x => eq(x, y)));
    return undefined;
  }
  if (isObj(v)) { const o = {}; for (const k of Object.keys(v)) { const r = resolveValue(v[k], isObj(old) ? old[k] : undefined); if (r !== undefined) o[k] = r; } return o; }
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(x => resolveValue(x, undefined));
  return v;
}
// set(..., {merge:true}): вложенные объекты сливаются, массивы заменяются, delete удаляет ключ
function deepMerge(base, patch) {
  const out = isObj(base) ? clone(base) : {};
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v instanceof Sentinel) {
      if (v.kind === 'delete') delete out[k]; else { const r = resolveValue(v, out[k]); if (r !== undefined) out[k] = r; }
    } else if (isObj(v)) out[k] = deepMerge(out[k], v);
    else { const r = resolveValue(v, out[k]); if (r !== undefined) out[k] = r; }
  }
  return out;
}
// update({'a.b': 1, c: FieldValue.delete()}): точка в ключе — путь вложенного поля
function applyUpdate(base, patch) {
  const out = clone(base) || {};
  for (const key of Object.keys(patch)) {
    const parts = key.split('.'); let cur = out;
    for (let i = 0; i < parts.length - 1; i++) { if (!isObj(cur[parts[i]])) cur[parts[i]] = {}; cur = cur[parts[i]]; }
    const last = parts[parts.length - 1], v = patch[key];
    if (v instanceof Sentinel && v.kind === 'delete') delete cur[last];
    else { const r = resolveValue(v, cur[last]); if (r !== undefined) cur[last] = r; }
  }
  return out;
}
function applyOp(prev, op) {           // prev — объект или null; возвращает новый объект или null (удалить)
  if (op.k === 'delete') return null;
  if (op.k === 'create') { if (prev) throw fsErr(6, 'ALREADY_EXISTS: ' + op.path); return resolveValue(op.data, undefined); }
  if (op.k === 'update') { if (!prev) throw fsErr(5, 'NOT_FOUND: ' + op.path); return applyUpdate(prev, op.data); }
  if (op.merge) return deepMerge(prev, op.data);
  return resolveValue(op.data, undefined);
}

// ---------- пути ----------
function splitPath(p) { const s = String(p).replace(/^\/+|\/+$/g, '').split('/'); if (s.some(x => !x)) throw new Error('bad path ' + p); return s; }
const parentOf = s => s.slice(0, -1).join('/');

// ---------- снимки ----------
class Ts { constructor(d) { this._d = d; } toDate() { return this._d; } toMillis() { return this._d.getTime(); } get seconds() { return Math.floor(this._d.getTime() / 1000); } }
class DocumentSnapshot {
  constructor(ref, row) { this.ref = ref; this.id = ref.id; this._row = row || null; this.exists = !!row; }
  data() { return this._row ? clone(this._row.data) : undefined; }
  get(f) { if (!this._row) return undefined; let v = this._row.data; for (const k of String(f).split('.')) { if (v == null) return undefined; v = v[k]; } return clone(v); }
  get createTime() { return this._row ? new Ts(new Date(this._row.create_time)) : undefined; }
  get updateTime() { return this._row ? new Ts(new Date(this._row.update_time)) : undefined; }
}
class QuerySnapshot {
  constructor(query, docs, changes) { this.query = query; this.docs = docs; this.size = docs.length; this.empty = docs.length === 0; this._ch = changes; this.metadata = { fromCache: false, hasPendingWrites: false }; }
  forEach(fn) { this.docs.forEach(fn); }
  docChanges() { return this._ch || this.docs.map((d, i) => ({ type: 'added', doc: d, oldIndex: -1, newIndex: i })); }
}

// ---------- ссылки ----------
class DocumentReference {
  constructor(db, segs) { this.firestore = db; this._s = segs; this.path = segs.join('/'); this.id = segs[segs.length - 1]; }
  get parent() { return new CollectionReference(this.firestore, this._s.slice(0, -1)); }
  collection(p) { return new CollectionReference(this.firestore, this._s.concat(splitPath(p))); }
  async get() { const r = await pg.query('SELECT data, create_time, update_time FROM fs_docs WHERE path = $1', [this.path]); return new DocumentSnapshot(this, r.rows[0]); }
  set(data, opts) { return this.firestore._write({ k: 'set', path: this.path, data, merge: !!(opts && (opts.merge || opts.mergeFields)) }); }
  update(data, ...rest) { if (typeof data === 'string') { const o = {}; o[data] = rest[0]; for (let i = 1; i < rest.length; i += 2) o[rest[i]] = rest[i + 1]; data = o; } return this.firestore._write({ k: 'update', path: this.path, data }); }
  create(data) { return this.firestore._write({ k: 'create', path: this.path, data }); }
  delete() { return this.firestore._write({ k: 'delete', path: this.path }); }
  onSnapshot(next, err) { return this.firestore._poll(() => this.get().then(s => ({ docs: s.exists ? [s] : [] })), docs => next(docs.length ? docs[0] : new DocumentSnapshot(this, null)), err, true); }
}

const OPS = new Set(['==', '!=', '<', '<=', '>', '>=', 'in', 'not-in', 'array-contains', 'array-contains-any']);
class Query {
  constructor(db, o) { this.firestore = db; this._o = Object.assign({ filters: [], orders: [], limit: null, offset: 0, after: null }, o); }
  _with(patch) { return new Query(this.firestore, Object.assign({}, this._o, patch)); }
  where(field, op, value) { if (!OPS.has(op)) throw new Error('operator ' + op); return this._with({ filters: this._o.filters.concat([{ f: String(field), op, v: value }]) }); }
  orderBy(field, dir) { return this._with({ orders: this._o.orders.concat([{ f: String(field), d: dir === 'desc' ? 'DESC' : 'ASC' }]) }); }
  limit(n) { return this._with({ limit: Math.max(0, n | 0) }); }
  offset(n) { return this._with({ offset: Math.max(0, n | 0) }); }
  startAfter(...a) { return this._with({ after: { a, incl: false } }); }
  startAt(...a) { return this._with({ after: { a, incl: true } }); }
  select() { return this; }
  _sql(lock) {
    const o = this._o, P = [], add = v => { P.push(v); return '$' + P.length; };
    const W = [o.group ? 'coll = ' + add(o.group) : 'parent = ' + add(o.parent)];
    const pathOf = f => add(f.split('.'));
    const ex = f => '(data #> ' + pathOf(f) + '::text[])';
    for (const x of o.filters) {
      if (x.f === NAME) {   // по id документа
        const idv = v => add(String(v && v.id !== undefined ? v.id : String(v).split('/').pop()));
        if (x.op === 'in') W.push('id = ANY(' + add(x.v.map(v => String(v && v.id !== undefined ? v.id : v).split('/').pop())) + '::text[])');
        else W.push('id ' + x.op.replace('==', '=').replace('!=', '<>') + ' ' + idv(x.v));
        continue;
      }
      const e = ex(x.f), v = x.v;
      if (x.op === '==') W.push(e + ' = ' + add(JSON.stringify(v)) + '::jsonb');
      else if (x.op === '!=') W.push(e + ' IS NOT NULL AND ' + e + ' <> ' + add(JSON.stringify(v)) + '::jsonb');
      else if (x.op === 'in') W.push(e + ' IN (SELECT jsonb_array_elements(' + add(JSON.stringify(v)) + '::jsonb))');
      else if (x.op === 'not-in') W.push(e + ' IS NOT NULL AND ' + e + ' NOT IN (SELECT jsonb_array_elements(' + add(JSON.stringify(v)) + '::jsonb))');
      else if (x.op === 'array-contains') W.push(e + ' @> jsonb_build_array(' + add(JSON.stringify(v)) + '::jsonb)');
      else if (x.op === 'array-contains-any') W.push('EXISTS (SELECT 1 FROM jsonb_array_elements(' + add(JSON.stringify(v)) + '::jsonb) z WHERE ' + e + ' @> jsonb_build_array(z))');
      else { // < <= > >=: сравнение только внутри одного типа (как в Firestore)
        const t = typeof v === 'number' ? 'number' : typeof v === 'string' ? 'string' : null;
        if (!t) throw new Error('range on ' + typeof v);
        W.push('jsonb_typeof(' + e + ") = '" + t + "' AND " + e + ' ' + x.op + ' ' + add(JSON.stringify(v)) + '::jsonb');
      }
    }
    const orders = o.orders.slice();
    for (const x of o.filters) if (['<', '<=', '>', '>='].includes(x.op) && x.f !== NAME && !orders.some(y => y.f === x.f)) orders.unshift({ f: x.f, d: 'ASC' });
    const O = [];
    for (const od of orders) {
      if (od.f === NAME) { O.push('id ' + od.d); continue; }
      W.push(ex(od.f) + ' IS NOT NULL'); O.push(ex(od.f) + ' ' + od.d);
    }
    const lastDir = orders.length ? orders[orders.length - 1].d : 'ASC';
    O.push('id ' + lastDir);
    if (o.after) {
      const a = o.after.a, op = o.after.incl ? '>=' : '>';
      if (orders.length === 0 || (orders.length === 1 && orders[0].f === NAME)) {
        const idv = a[0] && a[0].id !== undefined ? a[0].id : String(a[0]).split('/').pop();
        W.push('id ' + (orders.length && orders[0].d === 'DESC' ? (o.after.incl ? '<=' : '<') : op) + ' ' + add(String(idv)));
      } else if (orders.length === 1) {
        const dir = orders[0].d === 'DESC' ? (o.after.incl ? '<=' : '<') : op;
        const val = a[0] && a[0].ref ? a[0].get(orders[0].f) : a[0], idv = a[0] && a[0].id !== undefined ? a[0].id : null;
        if (idv !== null) W.push('(' + ex(orders[0].f) + ', id) ' + dir + ' (' + add(JSON.stringify(val)) + '::jsonb, ' + add(idv) + ')');
        else W.push(ex(orders[0].f) + ' ' + dir + ' ' + add(JSON.stringify(val)) + '::jsonb');
      } else throw new Error('startAfter: поддержан один ключ сортировки');
    }
    let sql = 'SELECT path, parent, id, data, create_time, update_time FROM fs_docs WHERE ' + W.join(' AND ') + ' ORDER BY ' + O.join(', ');
    if (o.limit !== null) sql += ' LIMIT ' + o.limit;
    if (o.offset) sql += ' OFFSET ' + o.offset;
    if (lock) sql += ' FOR UPDATE';
    return { sql, P };
  }
  _snap(rows) { return rows.map(r => new DocumentSnapshot(new DocumentReference(this.firestore, r.path.split('/')), r)); }
  async get(c) { const { sql, P } = this._sql(false); const r = await (c || pg).query(sql, P); return new QuerySnapshot(this, this._snap(r.rows)); }
  count() {
    return { get: async () => { const { sql, P } = this._sql(false); const r = await pg.query('SELECT count(*)::int AS n FROM (' + sql + ') q', P); return { data: () => ({ count: r.rows[0].n }) }; } };
  }
  onSnapshot(next, err) {
    let prev = new Map();
    return this.firestore._poll(() => this.get(), (docs, first) => {
      const cur = new Map(docs.map(d => [d.id, d])), ch = [];
      docs.forEach((d, i) => {
        const o = prev.get(d.id);
        if (!o) ch.push({ type: 'added', doc: d, oldIndex: -1, newIndex: i });
        else if (o.updateTime.toMillis() !== d.updateTime.toMillis() || o._row.update_time !== d._row.update_time) ch.push({ type: 'modified', doc: d, oldIndex: i, newIndex: i });
      });
      for (const [id, d] of prev) if (!cur.has(id)) ch.push({ type: 'removed', doc: d, oldIndex: 0, newIndex: -1 });
      prev = cur;
      next(new QuerySnapshot(this, docs, ch));
    }, err, false);
  }
}
class CollectionReference extends Query {
  constructor(db, segs) { super(db, { parent: segs.join('/') }); this._s = segs; this.path = segs.join('/'); this.id = segs[segs.length - 1]; }
  doc(id) { return new DocumentReference(this.firestore, id === undefined ? this._s.concat([require('crypto').randomBytes(10).toString('hex')]) : this._s.concat(splitPath(id))); }
  async add(data) { const r = this.doc(); await r.create(data); return r; }
}

// ---------- транзакции и запись ----------
const RETRY = new Set(['40001', '40P01', '23505']);
async function applyOps(c, ops) {
  for (const op of ops) {
    const segs = splitPath(op.path);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [op.path]);   // блокирует и ещё не созданный документ
    const r = await c.query('SELECT data FROM fs_docs WHERE path = $1 FOR UPDATE', [op.path]);
    const next = applyOp(r.rows[0] ? r.rows[0].data : null, op);
    if (next === null) { await c.query('DELETE FROM fs_docs WHERE path = $1', [op.path]); continue; }
    await c.query(
      'INSERT INTO fs_docs(path, parent, coll, id, data) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, update_time = now()',
      [op.path, parentOf(segs), segs[segs.length - 2], segs[segs.length - 1], JSON.stringify(next)]);
  }
}
class Transaction {
  constructor(db, c) { this._db = db; this._c = c; this._ops = []; }
  async get(x) {
    if (x instanceof DocumentReference) { await this._c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [x.path]); const r = await this._c.query('SELECT data, create_time, update_time FROM fs_docs WHERE path = $1 FOR UPDATE', [x.path]); return new DocumentSnapshot(x, r.rows[0]); }
    const { sql, P } = x._sql(true); const r = await this._c.query(sql, P); return new QuerySnapshot(x, x._snap(r.rows));
  }
  getAll(...refs) { return Promise.all(refs.map(r => this.get(r))); }
  set(ref, data, opts) { this._ops.push({ k: 'set', path: ref.path, data, merge: !!(opts && (opts.merge || opts.mergeFields)) }); return this; }
  update(ref, data, ...rest) { if (typeof data === 'string') { const o = {}; o[data] = rest[0]; for (let i = 1; i < rest.length; i += 2) o[rest[i]] = rest[i + 1]; data = o; } this._ops.push({ k: 'update', path: ref.path, data }); return this; }
  create(ref, data) { this._ops.push({ k: 'create', path: ref.path, data }); return this; }
  delete(ref) { this._ops.push({ k: 'delete', path: ref.path }); return this; }
}
class WriteBatch {
  constructor(db) { this._db = db; this._ops = []; }
  set(ref, data, opts) { this._ops.push({ k: 'set', path: ref.path, data, merge: !!(opts && (opts.merge || opts.mergeFields)) }); return this; }
  update(ref, data) { this._ops.push({ k: 'update', path: ref.path, data }); return this; }
  create(ref, data) { this._ops.push({ k: 'create', path: ref.path, data }); return this; }
  delete(ref) { this._ops.push({ k: 'delete', path: ref.path }); return this; }
  commit() { const ops = this._ops; this._ops = []; return pg.tx(c => applyOps(c, ops)).then(r => { if (ops.length) bus.emit('w'); return r; }); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
class Firestore {
  collection(p) { const s = splitPath(p); if (s.length % 2 !== 1) throw new Error('not a collection: ' + p); return new CollectionReference(this, s); }
  doc(p) { const s = splitPath(p); if (s.length % 2 !== 0) throw new Error('not a document: ' + p); return new DocumentReference(this, s); }
  collectionGroup(id) { return new Query(this, { group: String(id) }); }
  batch() { return new WriteBatch(this); }
  async getAll(...refs) { const out = []; for (const r of refs) out.push(await r.get()); return out; }
  async listCollections() { const r = await pg.query("SELECT DISTINCT split_part(parent, '/', 1) AS c FROM fs_docs ORDER BY 1"); return r.rows.map(x => new CollectionReference(this, [x.c])); }
  _write(op) { return pg.tx(c => applyOps(c, [op])).then(r => { bus.emit('w'); return r; }); }
  async runTransaction(fn) {
    let last;
    for (let attempt = 1; attempt <= 12; attempt++) {
      const p = pg.getPool(); if (!p) throw new Error('pg_disabled');
      const c = await p.connect();
      try {
        await c.query('BEGIN');
        const tx = new Transaction(this, c), res = await fn(tx);
        await applyOps(c, tx._ops);
        await c.query('COMMIT');
        if (tx._ops.length) bus.emit('w');
        return res;
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (e2) {}
        last = e;
        if (!(e && RETRY.has(e.code)) || attempt === 12) throw e;
        await sleep(Math.min(400, 10 * attempt) + Math.random() * 40 * attempt);   // взаимные блокировки: растущая случайная пауза
      } finally { c.release(); }
    }
    throw last;
  }
  // слушатель: опрос раз в PG_POLL_MS (по умолчанию 2 с), пока есть подписка
  _poll(fetch, emit, err, single) {
    const ms = Math.max(300, Number(process.env.PG_POLL_MS) || 2000);
    let stop = false, busy = false, sig = null, first = true;
    const tick = async () => {
      if (stop || busy) return; busy = true;
      try {
        const r = await fetch();
        const s = r.docs.map(d => d.id + '@' + (d._row ? d._row.update_time : '-')).join('|');
        if (s !== sig || first) { sig = s; const f = first; first = false; if (!stop) emit(r.docs, f); }
      } catch (e) { if (!stop) { stop = true; clearInterval(iv); if (err) err(e); } }
      busy = false;
    };
    const iv = setInterval(tick, ms); if (iv.unref) iv.unref();
    let kt = null; const kick = () => { if (kt || stop) return; kt = setTimeout(() => { kt = null; if (busy) { setTimeout(kick, 30); } else tick(); }, 25); };
    bus.on('w', kick);   // запись этим же процессом: проверяем сразу
    tick();
    return () => { stop = true; clearInterval(iv); bus.off('w', kick); };
  }
  terminate() { return pg.close(); }
}

let DB = null;
function firestore() { return DB || (DB = new Firestore()); }
firestore.FieldValue = FieldValue; firestore.FieldPath = FieldPath;
firestore.Timestamp = { now: () => new Ts(new Date()), fromMillis: ms => new Ts(new Date(ms)), fromDate: d => new Ts(d) };
// обёртка над firebase-admin: Auth и остальное — настоящие, firestore() — слой поверх Postgres
function wrap(admin) {
  return new Proxy(admin, { get(t, k) { if (k === 'firestore') return firestore; const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v; } });
}

module.exports = { firestore, wrap, FieldValue, FieldPath, Firestore, _internals: { applyOp, deepMerge, applyUpdate } };

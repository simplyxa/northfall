/* Клиентская часть шлюза данных (STORE=pg): объект, совместимый с firebase.firestore() по тем вызовам, что использует игра.
   Разовые операции — POST /api/fs; живые подписки — сообщения fsl/fsu/fss по сокету хаба (запасной путь — опрос по HTTP).
   Правила доступа применяет СЕРВЕР (server/fsrules.js); здесь ничего не проверяется. */
(function () {
  'use strict';
  var CODES = { 3: 'invalid-argument', 5: 'not-found', 6: 'already-exists', 7: 'permission-denied', 8: 'resource-exhausted', 12: 'unimplemented', 13: 'internal', 14: 'unavailable', 16: 'unauthenticated' };
  function FsError(code, msg) { var e = new Error(msg || CODES[code] || 'error'); e.code = CODES[code] || 'unknown'; e.nfCode = code; return e; }
  var ST = { getToken: null, wsSend: null, wsOk: false, helloDone: false, subs: {}, n: 0 };
  var POLL_MS = 4000;

  function rid() { var s = '', a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; for (var i = 0; i < 20; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function post(body) {
    return Promise.resolve(ST.getToken ? ST.getToken().catch(function () { return ''; }) : '').then(function (tok) {
      var h = { 'Content-Type': 'application/json' }; if (tok) h.Authorization = 'Bearer ' + tok;
      return fetch('/api/fs', { method: 'POST', headers: h, body: JSON.stringify(body), keepalive: false });
    }).then(function (r) { return r.json().catch(function () { return { ok: false, code: 13 }; }); }, function () { throw FsError(14, 'нет связи'); })
      .then(function (j) { if (!j || !j.ok) throw FsError(j && j.code || 13, j && j.msg); return j.r; });
  }

  function DocSnap(ref, ex, d) { this.ref = ref; this.id = ref.id; this.exists = !!ex; this._d = ex ? d : null; this.metadata = { fromCache: false, hasPendingWrites: false }; }
  DocSnap.prototype.data = function () { return this._d ? clone(this._d) : undefined; };
  DocSnap.prototype.get = function (f) { if (!this._d) return undefined; var v = this._d, p = String(f).split('.'); for (var i = 0; i < p.length; i++) { if (v == null) return undefined; v = v[p[i]]; } return clone(v); };
  function QSnap(docs, changes) {
    this.docs = docs; this.size = docs.length; this.empty = !docs.length; this._ch = changes || [];
    this.metadata = { fromCache: false, hasPendingWrites: false };
  }
  QSnap.prototype.forEach = function (f) { this.docs.forEach(f); };
  QSnap.prototype.docChanges = function () { return this._ch; };

  function DocRef(segs) { this._s = segs; this.path = segs.join('/'); this.id = segs[segs.length - 1]; }
  DocRef.prototype = {
    get parent() { return new ColRef(this._s.slice(0, -1)); },
    collection: function (p) { return new ColRef(this._s.concat(String(p).split('/'))); },
    get: function () { var me = this; return post({ op: 'get', path: this.path }).then(function (r) { return new DocSnap(me, r.ex, r.d); }); },
    set: function (data, opts) { return post({ op: 'set', path: this.path, data: data, merge: !!(opts && opts.merge) }).then(function () { }); },
    update: function (data, v) { if (typeof data === 'string') { var o = {}; o[data] = v; data = o; } return post({ op: 'update', path: this.path, data: data }).then(function () { }); },
    create: function (data) { return post({ op: 'create', path: this.path, data: data }).then(function () { }); },
    delete: function () { return post({ op: 'delete', path: this.path }).then(function () { }); },
    onSnapshot: function (cb, err) { return listen({ d: this.path }, this, cb, err); }
  };

  function Query(segs, o) { this._s = segs; this._o = o || { w: [], o: [], l: 0, sa: null }; this.path = segs.join('/'); }
  Query.prototype = {
    _with: function (p) { var o = this._o; return new Query(this._s, { w: p.w || o.w, o: p.o || o.o, l: p.l !== undefined ? p.l : o.l, sa: p.sa !== undefined ? p.sa : o.sa }); },
    where: function (f, op, v) { return this._with({ w: this._o.w.concat([[f, op, v]]) }); },
    orderBy: function (f, d) { return this._with({ o: this._o.o.concat([[f, d === 'desc' ? 'desc' : 'asc']]) }); },
    limit: function (n) { return this._with({ l: n | 0 }); },
    startAfter: function (x) { return this._with({ sa: x && x.ref ? { path: x.ref.path } : null }); },
    _q: function () { var o = this._o; return { p: this.path, w: o.w, o: o.o, l: o.l, sa: o.sa || undefined }; },
    get: function () { var me = this; return post({ op: 'list', q: this._q() }).then(function (r) { return new QSnap(mkDocs(r.docs)); }); },
    onSnapshot: function (cb, err) { return listen(this._q(), this, cb, err); }
  };
  function ColRef(segs) { Query.call(this, segs); this.id = segs[segs.length - 1]; }
  ColRef.prototype = Object.create(Query.prototype);
  ColRef.prototype.constructor = ColRef;
  ColRef.prototype.doc = function (id) { return new DocRef(this._s.concat([id === undefined ? rid() : String(id)])); };
  ColRef.prototype.add = function (data) { var r = this.doc(); return r.create(data).then(function () { return r; }); };
  Object.defineProperty(ColRef.prototype, 'parent', { get: function () { return this._s.length > 1 ? new DocRef(this._s.slice(0, -1)) : null; } });

  function mkDocs(arr) { return (arr || []).map(function (x) { return new DocSnap(new DocRef(x.p.split('/')), true, x.d); }); }

  // ---- подписки ----
  function listen(q, target, cb, err) {
    var id = 'L' + (++ST.n), isDoc = !!q.d;
    var L = ST.subs[id] = { id: id, q: q, cb: cb, err: err, target: target, isDoc: isDoc, map: {}, order: [], got: false, timer: null, last: null, dead: false };
    start(L);
    return function () { if (L.dead) return; L.dead = true; clearTimeout(L.timer); if (ST.wsOk && L.ws) ST.wsSend({ t: 'fsu', id: id }); delete ST.subs[id]; };
  }
  function start(L) {
    if (L.dead) return;
    if (ST.wsOk && ST.helloDone) { L.ws = true; L.got = false; ST.wsSend({ t: 'fsl', id: L.id, q: L.q }); clearTimeout(L.timer); }
    else { L.ws = false; poll(L, true); }
  }
  function poll(L, first) {
    if (L.dead || L.ws) return;
    var run = L.isDoc ? post({ op: 'get', path: L.q.d }).then(function (r) { return r.ex ? [{ p: L.q.d, d: r.d }] : []; }) : post({ op: 'list', q: L.q }).then(function (r) { return r.docs; });
    run.then(function (docs) {
      if (L.dead || L.ws) return;
      var sig = JSON.stringify(docs);
      if (sig !== L.last) { L.last = sig; L.map = {}; L.order = docs.map(function (x) { L.map[x.p] = x.d; return x.p; }); emit(L, true); }
    }, function (e) { if (L.err && first) { L.dead = true; delete ST.subs[L.id]; L.err(e); } })
      .then(function () { if (!L.dead && !L.ws) L.timer = setTimeout(function () { poll(L, false); }, POLL_MS); });
  }
  function emit(L, full) {
    var docs = L.order.map(function (p) { return new DocSnap(new DocRef(p.split('/')), true, L.map[p]); }), snap;
    if (L.isDoc) { try { L.cb(docs.length ? docs[0] : new DocSnap(L.target, false)); } catch (e) { console.error(e); } return; }
    snap = new QSnap(docs, L.ch || []); L.ch = [];
    try { L.cb(snap); } catch (e) { console.error(e); }
  }
  function onMsg(m) {
    var L = ST.subs[m.id]; if (!L) return false;
    if (m.t === 'fse') { if (m.code === 7 && !L.again) { L.again = 1; L.ws = false; L.last = null; poll(L, true); return true; }   // подписка ушла раньше, чем сервер узнал, кто мы (hello с токеном ещё в пути): один раз повторяем по HTTP, а после hello она снова пойдёт через сокет
    var e = FsError(m.code); L.dead = true; delete ST.subs[L.id]; if (L.err) try { L.err(e); } catch (x) { } return true; }
    if (m.t !== 'fss') return false;
    L.ws = true; if (m.full) { L.map = {}; L.order = []; }
    L.ch = L.ch || [];
    (m.up || []).forEach(function (u) { var had = L.map[u.p] !== undefined; L.map[u.p] = u.d; L.ch.push({ type: had ? 'modified' : 'added', doc: new DocSnap(new DocRef(u.p.split('/')), true, u.d) }); });
    (m.rm || []).forEach(function (p) { if (L.map[p] !== undefined) { L.ch.push({ type: 'removed', doc: new DocSnap(new DocRef(p.split('/')), true, L.map[p]) }); delete L.map[p]; } });
    if (m.o) L.order = m.o; else L.order = L.order.filter(function (p) { return L.map[p] !== undefined; });
    L.got = true; emit(L, !!m.full); return true;
  }
  // сокет открылся и приветствие (hello) отправлено — все подписки заново идут через сокет
  function onHello() { ST.helloDone = true; Object.keys(ST.subs).forEach(function (k) { var L = ST.subs[k]; clearTimeout(L.timer); start(L); }); }
  function onClose() {
    ST.helloDone = false; ST.wsOk = false;
    Object.keys(ST.subs).forEach(function (k) { var L = ST.subs[k]; L.ws = false; L.last = null; poll(L, false); });
  }

  var api = {
    create: function (getToken) {
      ST.getToken = getToken;
      return {
        collection: function (p) { return new ColRef(String(p).split('/')); },
        doc: function (p) { return new DocRef(String(p).split('/')); },
        _nfdb: true
      };
    },
    // связь с сокетом хаба: send — функция отправки объекта; вызывать при открытии/закрытии сокета и после hello
    attach: function (send) { ST.wsSend = send; },
    wsOpen: function () { ST.wsOk = true; },
    onHello: onHello, onClose: onClose, onMsg: onMsg,
    _state: ST
  };
  window.NFDB = api;
  if (typeof module !== 'undefined') module.exports = api;
})();

/* Matatu Rush: shared Top 5 board over the Firebase REST API (Firestore + Anonymous Auth).
   No SDK, no extra script tags. Hand-written calls to exactly three Google hosts (see DEFAULTS below).
   Online is ON only when CFG is filled in AND the page is served over http(s). From file:// this file makes
   no network request at all and the game behaves as an offline, one-device game.
   Data sent: a display name, a score and the server time, under an anonymous id. Nothing else.
   The server rules live in firestore.rules; BLOCKLIST here must stay identical to the one there. */
(function () {
  'use strict';
  var MR = window.MR;

  /* Fill these in after creating the Firebase project (README, "Shared Top 5 board"). Empty means offline. */
  var CFG = { projectId: '', apiKey: '' };

  var DEFAULTS = {
    authBase: 'https://identitytoolkit.googleapis.com',
    tokenBase: 'https://securetoken.googleapis.com',
    fsBase: 'https://firestore.googleapis.com'
  };

  var SCORE_MAX = 5000000;   /* same cap as firestore.rules */
  var NAME_MAX = 12;
  var NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,11}$/;
  var UID_RE = /^[A-Za-z0-9]{1,128}$/;
  var RATE_MS = 11000;       /* the server allows one write per device per 10 s; wait 11 s to be safe */
  var TOP_TIMEOUT = 8000;
  var NET_TIMEOUT = 10000;

  /* one list, lower case, matched as substrings of the lower-cased name. Identical to firestore.rules (a test checks). */
  var BLOCKLIST = [
    'nigger', 'nigga', 'faggot', 'retard', 'tranny', 'chink', 'gook', 'wetback', 'cunt', 'fuck',
    'shit', 'bitch', 'whore', 'slut', 'bastard', 'pussy', 'twat', 'wanker', 'bollock', 'piss',
    'rapist', 'hitler', 'asshole', 'arsehole', 'dickhead', 'cocksucker', 'kkk',
    'kuma', 'malaya', 'mjinga', 'pumbavu', 'mshenzi', 'msenge', 'shoga', 'mboo', 'mkundu',
    'nyoko', 'chokora', 'kunya'
  ];

  var AUTH_KEY = 'matatuRush.auth';
  var PENDING_KEY = 'matatuRush.pending';
  var BEST_KEY = 'matatuRush.onlineBest';
  var SEND_KEY = 'matatuRush.lastSend';

  function noop() { }
  function enc(s) { return encodeURIComponent(String(s)); }

  /* ---------- config ---------- */
  function conf() {
    var o = { projectId: CFG.projectId, apiKey: CFG.apiKey, authBase: DEFAULTS.authBase, tokenBase: DEFAULTS.tokenBase, fsBase: DEFAULTS.fsBase };
    var t = window.MR_ONLINE_TEST; /* test and emulator override only */
    if (t && typeof t === 'object') {
      for (var k in o) {
        if (Object.prototype.hasOwnProperty.call(o, k) && typeof t[k] === 'string' && t[k]) o[k] = t[k];
      }
    }
    o.authBase = o.authBase.replace(/\/+$/, '');
    o.tokenBase = o.tokenBase.replace(/\/+$/, '');
    o.fsBase = o.fsBase.replace(/\/+$/, '');
    return o;
  }
  function enabled() {
    var c = conf();
    var proto = '';
    try { proto = String(window.location.protocol); } catch (e) { proto = ''; }
    return !!(c.projectId && c.apiKey) && (proto === 'http:' || proto === 'https:');
  }

  /* ---------- names ---------- */
  function cleanName(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  }
  /* the same test the server applies: shape regex, then no blocklisted stem anywhere in the lower-cased name */
  function nameOk(n) {
    if (typeof n !== 'string' || !NAME_RE.test(n)) return false;
    var low = n.toLowerCase();
    for (var i = 0; i < BLOCKLIST.length; i++) if (low.indexOf(BLOCKLIST[i]) !== -1) return false;
    return true;
  }
  function resolveName(name, alias) {
    var n = cleanName(name);
    if (nameOk(n)) return n;
    var a = cleanName(alias);
    return nameOk(a) ? a : '';
  }
  /* names that come back from the network: strip controls and invisible characters, cap at 12. Shown with textContent only. */
  function displayName(s) {
    if (typeof s !== 'string') return '';
    s = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '');
    return s.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  }
  function wholeScore(v) {
    if (typeof v !== 'number' || !isFinite(v)) return 0;
    v = Math.floor(v);
    return (v > 0 && v <= SCORE_MAX) ? v : 0;
  }

  /* ---------- storage ---------- */
  function readJson(key) {
    var raw = MR.store.get(key, null);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  function readAuth() {
    var a = readJson(AUTH_KEY);
    if (!a || typeof a !== 'object') return null;
    if (typeof a.uid !== 'string' || !UID_RE.test(a.uid)) return null;
    if (typeof a.refreshToken !== 'string' || !a.refreshToken || a.refreshToken.length > 4000) return null;
    return { uid: a.uid, refreshToken: a.refreshToken };
  }
  function writeAuth(a) { MR.store.set(AUTH_KEY, JSON.stringify({ uid: a.uid, refreshToken: a.refreshToken })); }
  function getBest() {
    var v = parseInt(MR.store.get(BEST_KEY, '0'), 10);
    return (isFinite(v) && v > 0) ? v : 0;
  }
  function setBest(v) { MR.store.set(BEST_KEY, String(v)); }
  function readPending() {
    var p = readJson(PENDING_KEY);
    if (!p || typeof p !== 'object') return null;
    var score = wholeScore(p.score);
    var name = cleanName(p.name), alias = cleanName(p.alias);
    if (!score || (!name && !alias)) return null;
    return { name: name || alias, alias: alias, score: score };
  }
  function writePending(p) { MR.store.set(PENDING_KEY, JSON.stringify({ name: p.name, alias: p.alias, score: p.score })); }
  function clearPending() { MR.store.set(PENDING_KEY, ''); }
  var lastSend = (function () {
    var v = parseInt(MR.store.get(SEND_KEY, '0'), 10);
    return (isFinite(v) && v > 0) ? v : 0;
  })();

  /* ---------- the one place a request leaves this file ---------- */
  var api = {};
  /* main.js sets this to a function that returns true while a run is active; no request is made while it does */
  function blocked() {
    try { return !!(api.guard && api.guard()); } catch (e) { return true; }
  }
  /* cb(err, status, text). err is 'running' (blocked) or 'net' (no answer); otherwise null and the HTTP status is set. */
  function request(method, url, body, headers, timeoutMs, cb) {
    var done = false, x = null;
    function fin(err, status, text) { if (done) return; done = true; cb(err, status, text); }
    if (blocked()) { fin('running', 0, ''); return; }
    try {
      x = new XMLHttpRequest();
      x.open(method, url, true);
      x.timeout = timeoutMs;
      for (var h in headers) if (Object.prototype.hasOwnProperty.call(headers, h)) x.setRequestHeader(h, headers[h]);
      x.onload = function () { fin(null, x.status, x.responseText); };
      x.onerror = function () { fin('net', 0, ''); };
      x.ontimeout = function () { fin('net', 0, ''); };
      x.onabort = function () { fin('net', 0, ''); };
      x.send(body);
    } catch (e) { fin('net', 0, ''); }
  }
  function parseJson(text) { try { return JSON.parse(text); } catch (e) { return null; } }
  function failOf(status) {
    if (status === 0) return 'net';
    if (status === 400 || status === 403) return 'rejected';
    if (status === 401) return 'auth';
    return 'server';
  }

  /* ---------- anonymous auth over REST ---------- */
  var auth = null;          /* { uid, refreshToken } */
  var idToken = '', idExp = 0;
  function tokenValid() { return !!idToken && Date.now() < idExp; }
  function setToken(tok, expiresIn) {
    var s = parseInt(expiresIn, 10);
    if (!isFinite(s) || s <= 0) s = 3600;
    idToken = tok;
    idExp = Date.now() + Math.max(0, s - 60) * 1000;
  }

  function signUp(cb) {
    var c = conf();
    request('POST', c.authBase + '/v1/accounts:signUp?key=' + enc(c.apiKey), JSON.stringify({ returnSecureToken: true }),
      { 'Content-Type': 'application/json' }, NET_TIMEOUT, function (err, status, text) {
        if (err) { cb(err); return; }
        var j = parseJson(text);
        if (status !== 200 || !j || typeof j.idToken !== 'string' || typeof j.refreshToken !== 'string' ||
            typeof j.localId !== 'string' || !UID_RE.test(j.localId) || !j.idToken || !j.refreshToken) {
          cb(status === 0 ? 'net' : (status >= 500 || status === 429 ? 'server' : 'auth'));
          return;
        }
        auth = { uid: j.localId, refreshToken: j.refreshToken };
        writeAuth(auth);
        setToken(j.idToken, j.expiresIn);
        setBest(0); /* a new anonymous id has no entry on the server yet */
        cb(null);
      });
  }

  /* an invalid or expired refresh token (HTTP 400, or 401) means: sign up again, once */
  function refresh(cb) {
    var c = conf();
    request('POST', c.tokenBase + '/v1/token?key=' + enc(c.apiKey),
      'grant_type=refresh_token&refresh_token=' + enc(auth.refreshToken),
      { 'Content-Type': 'application/x-www-form-urlencoded' }, NET_TIMEOUT, function (err, status, text) {
        if (err) { cb(err); return; }
        var j = parseJson(text);
        if (status === 200 && j && typeof j.id_token === 'string' && j.id_token) {
          setToken(j.id_token, j.expires_in);
          if (typeof j.refresh_token === 'string' && j.refresh_token && j.refresh_token.length <= 4000) {
            auth.refreshToken = j.refresh_token;
            writeAuth(auth);
          }
          cb(null);
          return;
        }
        if (status === 400 || status === 401) {
          auth = null; idToken = ''; idExp = 0;
          signUp(cb);
          return;
        }
        cb(status === 0 ? 'net' : 'server');
      });
  }

  function ensureAuth(cb) {
    if (!auth) auth = readAuth();
    if (auth && tokenValid()) { cb(null); return; }
    if (auth) refresh(cb); else signUp(cb);
  }

  /* ---------- reading the board ---------- */
  var cache = null;
  function parseRows(list) {
    var rows = [];
    if (!Array.isArray(list)) return rows;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || typeof it !== 'object' || !it.document || typeof it.document !== 'object') continue;
      var d = it.document, f = d.fields;
      if (!f || typeof f !== 'object' || typeof d.name !== 'string') continue;
      var nm = f.name, sc = f.score;
      if (!nm || typeof nm !== 'object' || typeof nm.stringValue !== 'string') continue;
      if (!sc || typeof sc !== 'object' || typeof sc.integerValue !== 'string' || !/^[0-9]{1,15}$/.test(sc.integerValue)) continue;
      var score = parseInt(sc.integerValue, 10);
      var name = displayName(nm.stringValue);
      var id = d.name.split('/').pop();
      if (!name || !isFinite(score) || score <= 0 || !UID_RE.test(id)) continue;
      rows.push({ name: name, score: score, id: id, ord: rows.length });
    }
    rows.sort(function (a, b) { return (b.score - a.score) || (a.ord - b.ord); });
    rows = rows.slice(0, 5);
    for (var k = 0; k < rows.length; k++) delete rows[k].ord;
    return rows;
  }
  function copyRows(rows) {
    var out = [];
    for (var i = 0; i < rows.length; i++) out.push({ name: rows[i].name, score: rows[i].score, id: rows[i].id });
    return out;
  }

  /* cb(err, rows). On error rows is the last good result from this page load, or null. */
  function top(cb) {
    cb = cb || noop;
    if (!enabled()) { cb('disabled', null); return; }
    var c = conf();
    var body = JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'scores' }],
      orderBy: [{ field: { fieldPath: 'score' }, direction: 'DESCENDING' }],
      limit: 5
    } });
    request('POST', c.fsBase + '/v1/projects/' + enc(c.projectId) + '/databases/(default)/documents:runQuery?key=' + enc(c.apiKey),
      body, { 'Content-Type': 'application/json' }, TOP_TIMEOUT, function (err, status, text) {
        if (err) { cb(err, cache ? copyRows(cache) : null); return; }
        var j = status === 200 ? parseJson(text) : null;
        if (!Array.isArray(j)) { cb(status === 200 ? 'parse' : 'server', cache ? copyRows(cache) : null); return; }
        cache = parseRows(j);
        cb(null, copyRows(cache));
      });
  }

  /* ---------- writing the board ---------- */
  /* one commit: set scores/{uid} to {name, score, ts = server time}. No mask, no precondition: create or overwrite. */
  function commit(name, score, cb) {
    var c = conf();
    if (blocked()) { cb('running'); return; }
    var doc = 'projects/' + c.projectId + '/databases/(default)/documents/scores/' + auth.uid;
    var body = JSON.stringify({ writes: [{
      update: { name: doc, fields: { name: { stringValue: name }, score: { integerValue: String(score) } } },
      updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }]
    }] });
    lastSend = Date.now();
    MR.store.set(SEND_KEY, String(lastSend));
    request('POST', c.fsBase + '/v1/projects/' + enc(c.projectId) + '/databases/(default)/documents:commit?key=' + enc(c.apiKey),
      body, { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken }, NET_TIMEOUT, function (err, status) {
        if (err) { cb(err); return; }
        if (status === 200) { cb(null); return; }
        if (status === 401) { idToken = ''; idExp = 0; }
        cb(failOf(status));
      });
  }
  function accepted(score) { if (score > getBest()) setBest(score); }

  /* submit(name, score, cb, alias): sends right now (no pending queue, no rate wait). A name that fails the
     server's test is replaced by alias. cb(err, {name, score}). */
  function submit(name, score, cb, alias) {
    cb = cb || noop;
    if (!enabled()) { cb('disabled'); return; }
    var s = (typeof score === 'number') ? Math.floor(score) : 0;
    if (!(s > 0 && s <= SCORE_MAX)) { cb('badscore'); return; }
    var n = resolveName(name, alias);
    if (!n) { cb('badname'); return; }
    ensureAuth(function (err) {
      if (err) { cb(err); return; }
      commit(n, s, function (err2) {
        if (err2) { cb(err2); return; }
        accepted(s);
        cb(null, { name: n, score: s });
      });
    });
  }

  /* ---------- pending record: one per device, survives reloads ---------- */
  function queue(rec) {
    if (!enabled() || !rec || typeof rec !== 'object') return false;
    var score = wholeScore(rec.score);
    var alias = cleanName(rec.alias), name = cleanName(rec.name) || alias;
    if (!score || !name || score <= getBest()) return false;
    var cur = readPending();
    if (cur && cur.score >= score) return false; /* keep the higher one */
    writePending({ name: name, alias: alias, score: score });
    return true;
  }
  function rename(name) {
    var n = cleanName(name);
    var cur = readPending();
    if (!cur || !n) return false;
    cur.name = n;
    writePending(cur);
    return true;
  }

  var flushing = false, flushTimer = null, again = false;
  function waitMs() {
    if (!lastSend) return 0;
    var left = RATE_MS - (Date.now() - lastSend);
    if (left > RATE_MS) left = RATE_MS; /* the clock went backwards: never wait longer than one window */
    return left > 0 ? left : 0;
  }
  function finishFlush(cb, err, res) {
    flushing = false;
    var rerun = again && !err && !!readPending();
    again = false;
    cb(err || null, res || null);
    if (res && res.sent && typeof api.onSent === 'function') { try { api.onSent(res); } catch (e) { /* the hook must never break a flush */ } }
    if (rerun) flush(noop); /* a rename or better score arrived while sending: once more, still rate limited */
  }
  function flushNow(cb) {
    if (blocked()) { finishFlush(cb, 'running'); return; }
    var p = readPending();
    if (!p) { finishFlush(cb, null, { sent: false }); return; }
    ensureAuth(function (err) {
      if (err) { finishFlush(cb, err); return; }
      var n = resolveName(p.name, p.alias);
      if (!n) { clearPending(); finishFlush(cb, 'badname'); return; }
      commit(n, p.score, function (err2) {
        var cur = readPending();
        if (!err2) {
          accepted(p.score);
          /* cleared only if nothing newer arrived while the request was in the air */
          if (cur && cur.score <= p.score && cur.name === p.name) clearPending();
          finishFlush(cb, null, { sent: true, name: n, score: p.score });
          return;
        }
        if (err2 === 'rejected' && cur && cur.score <= p.score) clearPending(); /* rules said no: never retry it */
        finishFlush(cb, err2);
      });
    });
  }
  /* sends the pending record, if any. cb(err, res): res.sent is true when a record went out.
     Network trouble keeps the record; a rules rejection (400/403) drops it. Never two at once. */
  function flush(cb) {
    cb = cb || noop;
    if (!enabled()) { cb(null, { sent: false }); return; }
    if (flushing) { again = true; cb('busy'); return; }
    if (!readPending()) { cb(null, { sent: false }); return; }
    flushing = true;
    var w = waitMs();
    if (w > 0) {
      flushTimer = setTimeout(function () { flushTimer = null; flushNow(cb); }, w + 50);
    } else {
      flushNow(cb);
    }
  }

  api.enabled = enabled;
  api.top = top;
  api.submit = submit;
  api.queue = queue;
  api.rename = rename;
  api.flush = flush;
  api.guard = null;
  api.onSent = null; /* main.js: called after a pending record was accepted (also for the automatic second send) */
  api.uid = function () { if (!auth) auth = readAuth(); return auth ? auth.uid : ''; };
  api.best = getBest;
  api.pending = readPending;
  api.cached = function () { return cache ? copyRows(cache) : null; };
  api.nameOk = nameOk;
  api.BLOCKLIST = BLOCKLIST.slice();
  api.SCORE_MAX = SCORE_MAX;
  MR.online = api;
})();

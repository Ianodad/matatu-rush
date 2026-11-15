/* Matatu Rush: shared Top 5 board over the Firebase REST API (Firestore + Anonymous Auth).
   No SDK, no extra script tags. Hand-written calls to exactly three Google hosts (see DEFAULTS below).
   Online is ON only when CFG is filled in AND the page is served over http(s). From file:// this file makes
   no network request at all and the game behaves as an offline, one-device game.
   Data sent: a display name, a score and the server time, under an anonymous id. Nothing else.
   The server rules live in firestore.rules; BLOCKLIST here must stay identical to the one there. */
(function () {
  'use strict';
  var MR = window.MR;

  /* Settings come from js/config.js (README, "Shared Top 5 board"). Missing or empty means offline. */
  var CFG = (function (c) {
    var ok = c && typeof c.projectId === 'string' && typeof c.apiKey === 'string';
    return { projectId: ok ? c.projectId : '', apiKey: ok ? c.apiKey : '' };
  })(MR.ONLINE_CFG);

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

  /* one list, lower case. A name is refused when one of its tokens (the lower-cased name split on anything that is not
     a letter) EQUALS an entry, or an entry plus one of SUFFIXES. Whole tokens only, so Kumar, Shitote and Himalaya pass.
     Identical to firestore.rules (a test checks both lists). */
  var BLOCKLIST = [
    'nigger', 'nigga', 'faggot', 'retard', 'tranny', 'chink', 'gook', 'wetback', 'cunt', 'fuck',
    'shit', 'bitch', 'whore', 'slut', 'bastard', 'pussy', 'twat', 'wanker', 'bollock', 'piss',
    'rapist', 'hitler', 'asshole', 'arsehole', 'dickhead', 'cocksucker', 'kkk',
    'kuma', 'malaya', 'mjinga', 'pumbavu', 'mshenzi', 'msenge', 'shoga', 'mboo', 'mkundu',
    'nyoko', 'chokora', 'kunya'
  ];
  var SUFFIXES = ['s', 'es', 'er', 'ing'];

  var AUTH_KEY = 'matatuRush.auth';
  var PENDING_KEY = 'matatuRush.pending';
  var BEST_KEY = 'matatuRush.onlineBest';
  var SEND_KEY = 'matatuRush.lastSend';   /* last time a write request left OR was answered, shared by all tabs */
  var MAX_ATTEMPTS = 3;                   /* a pending record is dropped after this many 403/429 answers */

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

  /* test override, read only from the global and only when typed right: now() -> number, delayMs -> number. Never from storage or the URL. */
  function testOpt() { var t = window.MR_ONLINE_TEST; return (t && typeof t === 'object') ? t : null; }
  function now() {
    var t = testOpt();
    if (t && typeof t.now === 'function') {
      try { var v = t.now(); if (typeof v === 'number' && isFinite(v)) return v; } catch (e) { /* fall back to the real clock */ }
    }
    return Date.now();
  }
  function rateMs() {
    var t = testOpt();
    if (t && typeof t.delayMs === 'number' && isFinite(t.delayMs) && t.delayMs >= 0 && t.delayMs <= RATE_MS) return t.delayMs;
    return RATE_MS;
  }

  /* ---------- names ---------- */
  function cleanName(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  }
  function badToken(t) {
    for (var i = 0; i < BLOCKLIST.length; i++) {
      if (t === BLOCKLIST[i]) return true;
      for (var j = 0; j < SUFFIXES.length; j++) if (t === BLOCKLIST[i] + SUFFIXES[j]) return true;
    }
    return false;
  }
  /* the same test the server applies: shape regex, then no token of the lower-cased name is a blocklisted word */
  function nameOk(n) {
    if (typeof n !== 'string' || !NAME_RE.test(n)) return false;
    var toks = n.toLowerCase().split(/[^a-z]+/);
    for (var i = 0; i < toks.length; i++) if (toks[i] && badToken(toks[i])) return false;
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
    var at = parseInt(p.attempts, 10);
    return { name: name || alias, alias: alias, score: score, attempts: (isFinite(at) && at > 0) ? Math.min(at, MAX_ATTEMPTS) : 0 };
  }
  /* attempts is stored only once it is above 0, so a fresh record has exactly name, alias and score */
  function writePending(p) {
    var o = { name: p.name, alias: p.alias, score: p.score };
    if (p.attempts > 0) o.attempts = p.attempts;
    MR.store.set(PENDING_KEY, JSON.stringify(o));
  }
  function clearPending() { MR.store.set(PENDING_KEY, ''); }
  /* read fresh every time: another tab may have written since. A stored time later than now() means this device's clock
     moved (it was ahead when the value was written and has been corrected, or it jumped back): never trust it. Clamp to
     now (treat it as "just sent", at most one window of waiting) and rewrite the stored value so it is repaired for good. */
  function readSend() {
    var v = parseInt(MR.store.get(SEND_KEY, '0'), 10);
    if (!(isFinite(v) && v > 0)) return 0;
    var t = Math.floor(now());
    if (v > t) { v = t; MR.store.set(SEND_KEY, String(v)); }
    return v > 0 ? v : 0;
  }
  /* the later of what is stored and t: stamped when a write leaves AND when its answer arrives */
  function stampSend(t) {
    var cur = readSend();
    if (t > cur) MR.store.set(SEND_KEY, String(Math.floor(t)));
  }

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

  /* an invalid or expired refresh token (HTTP 400, 401 or 403) means: sign up again, at most once per flush or submit.
     A refresh answered 403 usually means the API key does not allow the Token Service API (README). Consequence of a
     fresh sign-up: the device gets a NEW anonymous id, so the row the old id left on the board stays there for good. */
  var resignups = 0;
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
        if (status === 400 || status === 401 || status === 403) {
          if (resignups >= 1) { cb('auth'); return; }
          resignups++;
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
  /* one commit: set scores/{uid} to {name, score, ts = server time}. No mask, no precondition: create or overwrite.
     The send time is stamped when the request leaves and again when the answer arrives (any answer, any outcome), in
     shared storage, so a slow connection or a second tab cannot make the next write land inside the server's 10 s window.
     cb(err, status). */
  function commit(name, score, cb) {
    var c = conf();
    if (blocked()) { cb('running', 0); return; }
    var doc = 'projects/' + c.projectId + '/databases/(default)/documents/scores/' + auth.uid;
    var body = JSON.stringify({ writes: [{
      update: { name: doc, fields: { name: { stringValue: name }, score: { integerValue: String(score) } } },
      updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }]
    }] });
    stampSend(now());
    request('POST', c.fsBase + '/v1/projects/' + enc(c.projectId) + '/databases/(default)/documents:commit?key=' + enc(c.apiKey),
      body, { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken }, NET_TIMEOUT, function (err, status) {
        stampSend(now());
        if (err) { cb(err, 0); return; }
        if (status === 200) { cb(null, 200); return; }
        if (status === 401) { idToken = ''; idExp = 0; }
        cb(failOf(status), status);
      });
  }
  /* reads this device's own entry: cb(err, null | { name, score, ts }). null means no entry yet (HTTP 404). */
  function fetchOwn(cb) {
    var c = conf();
    request('GET', c.fsBase + '/v1/projects/' + enc(c.projectId) + '/databases/(default)/documents/scores/' + enc(auth.uid) + '?key=' + enc(c.apiKey),
      null, {}, TOP_TIMEOUT, function (err, status, text) {
        if (err) { cb(err); return; }
        if (status === 404) { cb(null, null); return; }
        var j = status === 200 ? parseJson(text) : null;
        var f = j && typeof j === 'object' ? j.fields : null;
        if (!f || typeof f !== 'object' || !f.score || typeof f.score.integerValue !== 'string' || !/^[0-9]{1,15}$/.test(f.score.integerValue)) {
          cb(status === 200 ? 'parse' : failOf(status)); return;
        }
        var ts = (f.ts && typeof f.ts.timestampValue === 'string') ? Date.parse(f.ts.timestampValue) : NaN;
        cb(null, { name: (f.name && typeof f.name.stringValue === 'string') ? f.name.stringValue : '', score: parseInt(f.score.integerValue, 10), ts: isFinite(ts) ? ts : 0 });
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
    resignups = 0;
    ensureAuth(function (err) {
      if (err) { cb(err); return; }
      commit(n, s, function (err2) {
        if (err2) { cb(err2); return; }
        accepted(s);
        cb(null, { name: n, score: s });
      });
    });
  }

  /* ---------- pending record: one per device, survives reloads, shared by all tabs through storage ---------- */
  function queue(rec) {
    if (!enabled() || !rec || typeof rec !== 'object') return false;
    var score = wholeScore(rec.score);
    var alias = cleanName(rec.alias), name = cleanName(rec.name) || alias;
    if (!score || !name || score <= getBest()) return false;
    var cur = readPending(); /* fresh from storage: another tab may have queued or sent since */
    if (cur && cur.score >= score) return false; /* keep the higher one */
    writePending({ name: name, alias: alias, score: score, attempts: 0 });
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

  var flushing = false, flushTimer = null, retryTimer = null, again = false;
  var flushGen = 0, flushStart = 0;   /* flushGen: the flush that owns `flushing`; a flush that was given up on is stale */
  var FLUSH_DEAD_MS = 45000;          /* a flush busy for longer than this is considered dead (watchdog) */
  /* how long until the next write may leave: the stored send time is read fresh, never cached in this tab.
     readSend() never returns a time later than now(), so this is never more than one window. */
  function waitMs() {
    var last = readSend();
    if (!last) return 0;
    var left = rateMs() - (now() - last);
    if (left > rateMs()) left = rateMs();
    return left > 0 ? left : 0;
  }
  /* f.waited: a flush waits at most ONCE (one window at most). After that it sends, whatever the stored time says. */
  function afterWait(f, fn) {
    var w = f.waited ? 0 : waitMs();
    if (w > 0) {
      f.waited = true;
      flushTimer = setTimeout(function () { flushTimer = null; fn(); }, w + 50);
    } else fn();
  }
  /* one retry at a time, never sooner than one window after the last answer; flush() re-checks the stored time anyway */
  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () { retryTimer = null; flush(noop); }, rateMs() + 100);
  }
  /* every path of a flush ends here exactly once. Only the current flush releases `flushing`; a stale one just answers. */
  function finishFlush(f, err, res) {
    if (f.done) return;
    f.done = true;
    var cur = (f.gen === flushGen);
    var rerun = false;
    if (cur) {
      flushing = false;
      rerun = again && !err && !!readPending();
      again = false;
    }
    f.cb(err || null, res || null);
    if (res && res.sent && typeof api.onSent === 'function') { try { api.onSent(res); } catch (e) { /* the hook must never break a flush */ } }
    if (rerun) flush(noop); /* a rename or better score arrived while sending: once more, still rate limited */
  }
  /* synced: this attempt already re-read the server's copy of this device's entry */
  function flushNow(f, synced) {
    if (f.gen !== flushGen) { finishFlush(f, 'busy'); return; } /* given up on by the watchdog: a newer flush owns the record */
    if (blocked()) { finishFlush(f, 'running'); return; }
    var p = readPending(); /* fresh: another tab may have sent or replaced it while this one waited */
    if (!p) { finishFlush(f, null, { sent: false }); return; }
    /* everything the rules check, checked here first, so a 403 later most likely means timing and not a bad record */
    var n = resolveName(p.name, p.alias);
    if (!n) { clearPending(); finishFlush(f, 'badname'); return; }
    if (!wholeScore(p.score) || p.score < getBest()) { clearPending(); finishFlush(f, 'stale'); return; }
    ensureAuth(function (err) {
      if (err) { finishFlush(f, err); return; }
      var go = function () {
        /* another tab may have written while this one was signing in or re-reading: one wait at most per flush */
        afterWait(f, function () { if (f.gen !== flushGen) { finishFlush(f, 'busy'); return; } send(p, n, f); });
      };
      if (p.attempts > 0 && !synced) {
        /* an earlier attempt got 403/429: look at what the server really holds before sending again */
        fetchOwn(function (err2, own) {
          if (err2) {
            /* the read failed (403, 500, parse...): it counts as an attempt, then send anyway and let the rules decide.
               No answer at all ('net') is not counted: the send below fails the same way and keeps the record. */
            if (err2 !== 'net') {
              var cur1 = readPending();
              if (cur1 && cur1.score <= p.score && cur1.name === p.name) {
                cur1.attempts = (cur1.attempts || 0) + 1;
                if (cur1.attempts >= MAX_ATTEMPTS) { clearPending(); finishFlush(f, 'rejected'); return; }
                writePending(cur1);
              }
            }
            synced = true;
            go();
            return;
          }
          if (own) {
            if (own.score > 0) setBest(own.score);
            if (own.ts > 0) stampSend(Math.min(own.ts, now())); /* never trust a server time ahead of this clock */
            if (own.score > p.score || (own.score === p.score && own.name === n)) {
              var cur0 = readPending();
              if (cur0 && cur0.score <= p.score && cur0.name === p.name) clearPending();
              finishFlush(f, null, { sent: false });
              return;
            }
          }
          var again2 = readPending();
          if (!again2 || again2.score !== p.score || again2.name !== p.name) { flushNow(f, true); return; } /* replaced meanwhile */
          synced = true;
          go();
        });
        return;
      }
      go();
    });
  }
  function send(p, n, f) {
    commit(n, p.score, function (err2, status) {
      var cur = readPending();
      if (!err2) {
        accepted(p.score);
        /* cleared only if nothing newer arrived while the request was in the air */
        if (cur && cur.score <= p.score && cur.name === p.name) clearPending();
        finishFlush(f, null, { sent: true, name: n, score: p.score });
        return;
      }
      var same = !!cur && cur.score <= p.score && cur.name === p.name;
      if (status === 400) { /* malformed: never retry */
        if (same) clearPending();
        finishFlush(f, 'rejected');
        return;
      }
      if (status === 403 || status === 429) {
        /* 403 also means "written less than 10 s ago". Keep the record, count the attempt, retry once later. */
        if (same) {
          cur.attempts = (cur.attempts || 0) + 1;
          if (cur.attempts >= MAX_ATTEMPTS) { clearPending(); finishFlush(f, 'rejected'); return; }
          writePending(cur);
          scheduleRetry();
        }
        finishFlush(f, 'retry');
        return;
      }
      finishFlush(f, err2);
    });
  }
  /* sends the pending record, if any. cb(err, res): res.sent is true when a record went out.
     Network trouble keeps the record. A 403 or 429 keeps it and retries once, 11 s after the answer, up to 3 attempts
     in all; a 400 drops it. Never two at once. A flush waits at most one window before it sends, and a flush that has
     been busy for more than 45 s is taken for dead: a new one may start (the old one can only answer, never send). */
  function flush(cb) {
    cb = cb || noop;
    if (!enabled()) { cb(null, { sent: false }); return; }
    if (flushing) {
      var age = now() - flushStart;
      if (age > FLUSH_DEAD_MS || age < -FLUSH_DEAD_MS) {
        flushing = false; /* the old flush is stale from here on (its gen no longer matches): it can only answer, never send */
      } else { again = true; cb('busy'); return; }
    }
    if (!readPending()) { cb(null, { sent: false }); return; }
    flushing = true;
    flushStart = now();
    again = false;
    resignups = 0;
    var f = { gen: ++flushGen, cb: cb, waited: false, done: false };
    afterWait(f, function () { flushNow(f, false); });
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
  api.SUFFIXES = SUFFIXES.slice();
  api.sharedName = resolveName; /* the name the shared board would get: name if it passes, else alias, else '' */
  api.SCORE_MAX = SCORE_MAX;
  MR.online = api;
})();

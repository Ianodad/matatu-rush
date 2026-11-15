#!/usr/bin/env node
/* Matatu Rush: Firestore rules tests + the real client (js/online.js) end to end, both against the LOCAL
   Firebase emulators. Not part of tests/run-tests.cjs. It never touches a real Firebase project.

   Tooling is installed outside the repo (see README, "Shared Top 5 board"). Run from any folder that has
   the tools in node_modules:

     NODE_PATH=/path/to/scratch/node_modules /path/to/scratch/node_modules/.bin/firebase \
       emulators:exec --config /path/to/repo/firebase.json --only firestore,auth --project demo-matatu \
       "node /path/to/repo/tests/rules-test.cjs"

   Needs Java 17+ (the Firestore emulator) and Node 18+ (global fetch). Exit code 0 means every case passed. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
const PROJECT = 'demo-matatu';

const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const fsdk = require('firebase/firestore');
const { doc, setDoc, getDoc, getDocs, deleteDoc, collection, query, orderBy, limit, serverTimestamp, Timestamp } = fsdk;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, passed = 0;
const failures = [];
function record(ok, label, extra) {
  total++;
  if (ok) passed++; else failures.push(label + (extra ? ' :: ' + extra : ''));
}
async function allow(label, p) {
  try { await assertSucceeds(p); record(true, label); }
  catch (e) { record(false, 'EXPECTED ALLOW: ' + label, String(e && e.message || e).slice(0, 160)); }
}
async function deny(label, p) {
  try { await assertFails(p); record(true, label); }
  catch (e) { record(false, 'EXPECTED DENY: ' + label, String(e && e.message || e).slice(0, 160)); }
}

/* values pulled from the rules file, so the tests follow what is really deployed */
const stems = (/\(\^\|\.\*\[\^a-z\]\)\(([a-z|]+)\)/.exec(RULES) || [null, ''])[1].split('|').filter(Boolean);
const SCORE_MAX = parseInt((/s <= (\d+)/.exec(RULES) || [0, '0'])[1], 10);

function mixed(s) { return s.split('').map((c, i) => (i % 2 ? c.toLowerCase() : c.toUpperCase())).join(''); }

(async () => {
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: RULES } });
  let n = 0;
  const nextUid = () => 'u' + (++n) + 'x' + Math.random().toString(36).slice(2, 8);
  const as = (uid) => env.authenticatedContext(uid).firestore();
  const anon = () => env.unauthenticatedContext().firestore();
  const good = (over) => Object.assign({ name: 'Dere 482', score: 1000, ts: serverTimestamp() }, over || {});
  /* write straight to the database (rules off) with a chosen age of the last write */
  async function seed(uid, name, score, ageMs) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'scores', uid), { name, score, ts: Timestamp.fromMillis(Date.now() - ageMs) });
    });
  }
  async function seedPlain(path1, data) {
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), path1), data); });
  }
  const create = (uid, data, who) => setDoc(doc(who || as(uid), 'scores', uid), data);

  console.log('Rules file: ' + stems.length + ' blocklist stems, SCORE_MAX ' + SCORE_MAX);
  record(stems.length >= 25 && stems.length <= 40, 'blocklist has 25 to 40 stems', String(stems.length));
  record(SCORE_MAX === 5000000, 'SCORE_MAX parsed from the rules', String(SCORE_MAX));

  /* ---------- create: who ---------- */
  console.log('create: identity');
  { const u = nextUid(); await allow('owner creates a valid entry', create(u, good())); }
  { const u = nextUid(); await deny('unauthenticated create', create(u, good(), anon())); }
  { const a = nextUid(), b = nextUid(); await deny('write to another uid document', setDoc(doc(as(a), 'scores', b), good())); }

  /* ---------- create: shape ---------- */
  console.log('create: shape');
  { const u = nextUid(); await deny('extra field', create(u, good({ extra: 1 }))); }
  { const u = nextUid(); await deny('missing name', create(u, { score: 10, ts: serverTimestamp() })); }
  { const u = nextUid(); await deny('missing score', create(u, { name: 'Bob', ts: serverTimestamp() })); }
  { const u = nextUid(); await deny('missing ts', create(u, { name: 'Bob', score: 10 })); }
  { const u = nextUid(); await deny('empty document', create(u, {})); }

  /* ---------- create: score ---------- */
  console.log('create: score');
  const badScores = [
    ['score 0', 0], ['score negative', -5], ['score float 1.5', 1.5], ['score float 999999.5', 999999.5], ['score string "100"', '100'],
    ['score null', null], ['score true', true], ['score above cap', SCORE_MAX + 1], ['score far above cap', 99999999999], ['score list', [10]], ['score NaN', NaN]
  ];
  for (const [label, v] of badScores) { const u = nextUid(); await deny(label, create(u, good({ score: v }))); }
  { const u = nextUid(); await allow('score exactly at cap', create(u, good({ score: SCORE_MAX }))); }
  { const u = nextUid(); await allow('score 1', create(u, good({ score: 1 }))); }
  { const u = nextUid(); await allow('score 40000 (a strong real run)', create(u, good({ score: 40000 }))); }

  /* ---------- create: name ---------- */
  console.log('create: name');
  const goodNames = ['Bob', 'B', 'Dere 482', 'Konda 100', 'Makanga 999', 'Rubani 123', 'a_b-c.d e', '123456789012', 'Mwangi Kamau', 'Class Act', 'Sussex',
    'Kumar', 'Kumari', 'Shitote', 'Shitanda', 'Himalaya', 'Mbooni', 'Kunyanga', 'Malayan', 'Scunthorpe', 'Pissarides'];
  for (const nm of goodNames) { const u = nextUid(); await allow('name allowed: "' + nm + '"', create(u, good({ name: nm }))); }
  const badNames = [
    ['empty name', ''], ['13 chars', '1234567890123'], ['leading space', ' Bob'], ['leading hyphen', '-Bob'], ['leading dot', '.Bob'], ['leading underscore', '_Bob'],
    ['unicode accent', 'Wanjirú'], ['unicode wide letter', 'Ｂob'], ['emoji', 'Bob 🚀'], ['CJK', '你好'],
    ['HTML tag', '<b>x</b>'], ['img onerror', '<img onerror=x>'], ['ampersand', 'a&b'], ['quote', 'a"b'], ['apostrophe', "O'Brien"], ['backslash', 'a\\b'],
    ['newline at end', 'Bob\n'], ['tab inside', 'a\tb'], ['name number', 123], ['name null', null], ['name list', ['Bob']], ['name bool', true]
  ];
  for (const [label, v] of badNames) { const u = nextUid(); await deny('name denied: ' + label, create(u, good({ name: v }))); }

  console.log('create: blocklist (' + stems.length + ' words, whole tokens: alone, digits around, separate token, plural, case)');
  for (const st of stems) {
    const variants = [['lower', st], ['UPPER', st.toUpperCase()], ['MiXeD', mixed(st)], ['digits around', '6' + st + '9'],
      ['separate token', 'a ' + st], ['dot separated', st + '.x'], ['plural', st + 's'], ['-ing', st + 'ing']];
    for (const [kind, v] of variants) {
      if (v.length > 12) continue; /* the shape rule would refuse it anyway, so it proves nothing about the blocklist */
      const u = nextUid();
      await deny('blocklist "' + st + '" ' + kind + ' -> "' + v + '"', create(u, good({ name: v })));
    }
  }

  /* ---------- create: ts ---------- */
  console.log('create: ts');
  { const u = nextUid(); await deny('client supplied ts (now)', create(u, good({ ts: Timestamp.now() }))); }
  { const u = nextUid(); await deny('client supplied ts (a Date)', create(u, good({ ts: new Date() }))); }
  { const u = nextUid(); await deny('client supplied ts (far future)', create(u, good({ ts: Timestamp.fromMillis(Date.now() + 86400000) }))); }
  { const u = nextUid(); await deny('ts as a string', create(u, good({ ts: 'now' }))); }
  { const u = nextUid(); await deny('ts null', create(u, good({ ts: null }))); }
  { const u = nextUid(); await deny('ts a number', create(u, good({ ts: Date.now() }))); }
  { const u = nextUid(); await allow('server timestamp', create(u, good())); }

  /* ---------- update ---------- */
  console.log('update');
  { const u = nextUid(); await seed(u, 'Old', 100, 60000); await allow('higher score after a minute', create(u, good({ name: 'New', score: 150 }))); }
  { const u = nextUid(); await seed(u, 'Old', 100, 60000); await allow('equal score (rename only) after a minute', create(u, good({ name: 'Renamed', score: 100 }))); }
  { const u = nextUid(); await seed(u, 'Old', 100, 60000); await deny('lower score', create(u, good({ name: 'Old', score: 99 }))); }
  { const u = nextUid(); await seed(u, 'Old', 100, 60000); await deny('score back to 1', create(u, good({ score: 1 }))); }
  { const u = nextUid(); await seed(u, 'Old', 100, 2000); await deny('higher score only 2 s after the last write', create(u, good({ score: 500 }))); }
  { const u = nextUid(); await seed(u, 'Old', 100, 9000); await deny('higher score 9 s after the last write', create(u, good({ score: 500 }))); }
  { const u = nextUid(); await seed(u, 'Old', 100, 11500); await allow('higher score 11.5 s after the last write', create(u, good({ score: 500 }))); }
  { const u = nextUid(), v = nextUid(); await seed(u, 'Old', 100, 60000); await deny('another uid updates my entry', setDoc(doc(as(v), 'scores', u), good({ score: 500 }))); }
  { const u = nextUid(); await seed(u, 'Old', 100, 60000); await deny('unauthenticated update', setDoc(doc(anon(), 'scores', u), good({ score: 500 }))); }
  { const u = nextUid(); await seed(u, 'Old', 100, 60000); await deny('update with an extra field', create(u, good({ score: 500, extra: 'x' }))); }
  { const u = nextUid(); await seed(u, 'Old', 100, 60000); await deny('update with a blocklisted name', create(u, good({ name: 'fuck', score: 500 }))); }
  { const u = nextUid(); await seed(u, 'Old', 100, 60000); await deny('update with a bad name', create(u, good({ name: '<b>', score: 500 }))); }
  { const u = nextUid(); await seed(u, 'Old', 100, 60000); await deny('update with a client ts', create(u, good({ score: 500, ts: Timestamp.now() }))); }
  { const u = nextUid(); await seed(u, 'Old', 100, 60000); await deny('update above cap', create(u, good({ score: SCORE_MAX + 1 }))); }
  { const u = nextUid(); await seed(u, 'Old', 100, 60000); await allow('update to exactly the cap', create(u, good({ score: SCORE_MAX }))); }
  { const u = nextUid(); await seed(u, 'Old', SCORE_MAX, 60000); await allow('at the cap, equal score rename', create(u, good({ name: 'Cap', score: SCORE_MAX }))); }

  console.log('update: live 10 s rate limit (waits 11 s once)');
  {
    const u = nextUid();
    await allow('live: first write (create)', create(u, good({ score: 700 })));
    await deny('live: second write straight away', create(u, good({ score: 800 })));
    await sleep(11000);
    await allow('live: equal score rename 11 s later', create(u, good({ name: 'Later', score: 700 })));
    await deny('live: another write straight after that', create(u, good({ name: 'Again', score: 900 })));
  }

  /* ---------- delete ---------- */
  console.log('delete');
  { const u = nextUid(); await seed(u, 'Old', 100, 60000); await deny('owner deletes own entry', deleteDoc(doc(as(u), 'scores', u))); }
  { const u = nextUid(), v = nextUid(); await seed(u, 'Old', 100, 60000); await deny('other uid deletes', deleteDoc(doc(as(v), 'scores', u))); }
  { const u = nextUid(); await seed(u, 'Old', 100, 60000); await deny('unauthenticated delete', deleteDoc(doc(anon(), 'scores', u))); }

  /* ---------- reads ---------- */
  console.log('reads');
  { const u = nextUid(); await seed(u, 'Reader', 321, 60000); await allow('unauthenticated get', getDoc(doc(anon(), 'scores', u))); await allow('authenticated get of another entry', getDoc(doc(as(nextUid()), 'scores', u))); }
  await allow('get of a document that does not exist', getDoc(doc(anon(), 'scores', 'nobody')));
  await allow('list: orderBy score desc limit 5 (what the game sends)', getDocs(query(collection(anon(), 'scores'), orderBy('score', 'desc'), limit(5))));
  await allow('list: limit 10', getDocs(query(collection(anon(), 'scores'), orderBy('score', 'desc'), limit(10))));
  await allow('list: limit 1', getDocs(query(collection(anon(), 'scores'), limit(1))));
  await deny('list: limit 11', getDocs(query(collection(anon(), 'scores'), orderBy('score', 'desc'), limit(11))));
  await deny('list: limit 1000', getDocs(query(collection(anon(), 'scores'), orderBy('score', 'desc'), limit(1000))));
  await deny('list: no limit', getDocs(collection(anon(), 'scores')));
  /* offset: the web SDK cannot send one, so these go through the REST runQuery endpoint, without credentials (rules apply) */
  const fsHostR = process.env.FIRESTORE_EMULATOR_HOST;
  async function restQuery(extra) {
    const body = { structuredQuery: Object.assign({ from: [{ collectionId: 'scores' }], orderBy: [{ field: { fieldPath: 'score' }, direction: 'DESCENDING' }], limit: 5 }, extra) };
    const r = await fetch('http://' + fsHostR + '/v1/projects/' + PROJECT + '/databases/(default)/documents:runQuery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.status;
  }
  if (fsHostR) {
    { const st = await restQuery({}); record(st === 200, 'list via REST: limit 5, offset absent -> allowed', String(st)); }
    { const st = await restQuery({ offset: 0 }); record(st === 200, 'list via REST: limit 5, explicit offset 0 -> allowed', String(st)); }
    { const st = await restQuery({ offset: 1 }); record(st === 403, 'list via REST: offset 1 -> denied', String(st)); }
    { const st = await restQuery({ offset: 100000 }); record(st === 403, 'list via REST: offset 100000 -> denied', String(st)); }
    { const st = await restQuery({ limit: 11 }); record(st === 403, 'list via REST: limit 11 -> denied', String(st)); }
  } else record(false, 'FIRESTORE_EMULATOR_HOST is set for the REST offset checks');
  await deny('list: orderBy but no limit', getDocs(query(collection(anon(), 'scores'), orderBy('score', 'desc'))));
  { const r = await getDocs(query(collection(anon(), 'scores'), orderBy('score', 'desc'), limit(5))); record(r.size >= 1 && r.size <= 5, 'list returns at most 5 rows', String(r.size)); }

  /* ---------- everything else ---------- */
  console.log('everything else is denied');
  { const u = nextUid(); await deny('write to another collection (auth)', setDoc(doc(as(u), 'other', 'doc1'), { a: 1 })); }
  { const u = nextUid(); await deny('write to users/{uid} (auth)', setDoc(doc(as(u), 'users', u), { name: 'Bob', score: 5, ts: serverTimestamp() })); }
  { const u = nextUid(); await deny('write to a subcollection of scores', setDoc(doc(as(u), 'scores', u, 'sub', 'x'), good())); }
  { await seedPlain('secret/doc1', { a: 1 }); await deny('read another collection (anon)', getDoc(doc(anon(), 'secret', 'doc1'))); }
  await deny('list another collection', getDocs(query(collection(anon(), 'secret'), limit(5))));
  { const u = nextUid(); await seedPlain('secret/doc2', { a: 1 }); await deny('read another collection (auth)', getDoc(doc(as(u), 'secret', 'doc2'))); }
  { const u = nextUid(); await deny('same shape written to a differently named collection', setDoc(doc(as(u), 'scoreboard', u), good())); }

  await env.clearFirestore(); /* the real-client run below starts on an empty database */
  await env.cleanup();
  console.log('\nRULES CASES: ' + passed + '/' + total + ' passed');

  /* ================= the real client against the emulators ================= */
  console.log('\nreal client (js/online.js) against the emulators');
  const e2e = { total: 0, passed: 0, fails: [] };
  function chk(ok, label, extra) {
    e2e.total++;
    if (ok) e2e.passed++; else e2e.fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
    console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined && !ok ? '  -> ' + JSON.stringify(extra) : ''));
  }
  const fsHost = process.env.FIRESTORE_EMULATOR_HOST, authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!fsHost || !authHost) { console.log('FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST not set (run through emulators:exec)'); process.exit(2); }

  class XHR {
    constructor() { this.status = 0; this.responseText = ''; this.h = {}; }
    open(m, u) { this.m = m; this.u = u; }
    setRequestHeader(k, v) { this.h[k] = v; }
    send(b) {
      fetch(this.u, { method: this.m, headers: this.h, body: b })
        .then(async (r) => { this.status = r.status; this.responseText = await r.text(); if (this.onload) this.onload(); })
        .catch(() => { if (this.onerror) this.onerror(); });
    }
  }
  /* a "page load": fresh module state, shared localStorage (the Map) */
  function boot(storageMap, opt) {
    opt = opt || {};
    const win = {
      location: { protocol: 'http:', search: '' },
      localStorage: { getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null), setItem: (k, v) => { storageMap.set(k, String(v)); }, removeItem: (k) => { storageMap.delete(k); } },
      MR_ONLINE_TEST: opt.cfg || { projectId: PROJECT, apiKey: 'fake-key', authBase: 'http://' + authHost + '/identitytoolkit.googleapis.com', tokenBase: 'http://' + authHost + '/securetoken.googleapis.com', fsBase: 'http://' + fsHost },
      XMLHttpRequest: XHR, setTimeout, clearTimeout
    };
    win.window = win;
    const ctx = vm.createContext(win);
    for (const f of ['js/core.js', 'js/online.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    return win.MR;
  }
  const call = (fn) => new Promise((res) => fn((err, val) => res({ err, val })));
  async function until(fn, ms) { const t0 = Date.now(); for (;;) { if (fn()) return true; if (Date.now() - t0 > ms) return false; await sleep(200); } }
  const readMap = (m, k) => { try { return JSON.parse(m.get(k)); } catch (e) { return null; } };

  {
    const store = new Map(); const MR = boot(store); const o = MR.online;
    chk(o.enabled() === true, 'enabled() is true with config and http');
    const r0 = await call((cb) => o.top(cb));
    const base = (r0.val || []).length;
    chk(!r0.err && Array.isArray(r0.val), 'top() on the emulator answers with a list', r0);
    const s1 = await call((cb) => o.submit('Dere 482', 1234, cb, 'Konda 111'));
    chk(!s1.err && s1.val && s1.val.name === 'Dere 482' && s1.val.score === 1234, 'sign up + submit works', s1);
    const auth = readMap(store, 'matatuRush.auth');
    chk(!!auth && typeof auth.uid === 'string' && auth.uid.length > 10 && typeof auth.refreshToken === 'string', 'uid and refresh token stored under matatuRush.auth', auth && { uid: auth.uid });
    chk(o.best() === 1234 && o.uid() === auth.uid, 'onlineBest and uid recorded');
    const t1 = await call((cb) => o.top(cb));
    const mine = (t1.val || []).filter((x) => x.id === auth.uid)[0];
    chk(!t1.err && !!mine && mine.name === 'Dere 482' && mine.score === 1234, 'top() reads the new entry back (name, integer score, id = uid)', t1);
    chk(t1.val.length <= 5 && t1.val.every((x, i) => i === 0 || t1.val[i - 1].score >= x.score), 'top() is at most 5 rows, sorted high to low');
    const s2 = await call((cb) => o.submit('x', 1, cb, 'Konda 111'));
    chk(s2.err === 'rejected', 'a lower score straight after is refused by the server (rejected)', s2);
  }
  {
    const store = new Map(); const MR = boot(store); const o = MR.online;
    const s = await call((cb) => o.submit('fuck me', 777, cb, 'Konda 222'));
    chk(!s.err && s.val.name === 'Konda 222', 'blocklisted name: the alias is sent instead (accepted by the server)', s);
    const s3 = await call((cb) => o.submit('Wanjirú', 888, cb, ''));
    chk(s3.err === 'badname', 'non-ASCII name with no usable alias: nothing is sent (badname)', s3);
    const t = await call((cb) => o.top(cb));
    chk((t.val || []).some((x) => x.name === 'Konda 222' && x.score === 777), 'the alias row is on the shared board', t);
  }
  {
    /* the full pending path: queue, rename, flush; then a second, higher score inside 11 s is delayed, not denied */
    const store = new Map(); const MR = boot(store); const o = MR.online;
    chk(o.queue({ name: 'Rubani 301', alias: 'Rubani 301', score: 5000 }) === true, 'queue() accepts a new best');
    chk(o.queue({ name: 'Rubani 301', alias: 'Rubani 301', score: 4000 }) === false, 'queue() keeps the higher pending score');
    chk(o.rename('Mama Pima') === true && o.pending().name === 'Mama Pima', 'rename() updates the pending name');
    const f1 = await call((cb) => o.flush(cb));
    chk(!f1.err && f1.val && f1.val.sent === true && o.pending() === null && o.best() === 5000, 'flush() sends it, clears pending, records onlineBest', f1);
    const uid = o.uid();
    let t = await call((cb) => o.top(cb));
    chk((t.val || []).some((x) => x.id === uid && x.name === 'Mama Pima' && x.score === 5000), 'shared board shows the typed name');
    chk(o.queue({ name: 'Mama Pima', alias: 'Rubani 301', score: 6000 }) === true, 'a higher score queues again');
    const t0 = Date.now();
    const f2 = await call((cb) => o.flush(cb));
    const waited = Date.now() - t0;
    chk(!f2.err && f2.val && f2.val.sent === true && waited >= 10500, 'the second flush inside 11 s waits (' + waited + ' ms) and is then accepted by the server', { f2, waited });
    t = await call((cb) => o.top(cb));
    chk((t.val || []).some((x) => x.id === uid && x.score === 6000), 'shared board shows 6000 for the same uid');

    /* "reload": same storage, new module state. The access token is gone, so the refresh-token path is used. */
    await sleep(11200);
    const MR2 = boot(store); const o2 = MR2.online;
    chk(o2.uid() === uid, 'after a reload the uid comes from storage');
    o2.queue({ name: 'Mama Pima', alias: 'Rubani 301', score: 7000 });
    const f3 = await call((cb) => o2.flush(cb));
    chk(!f3.err && f3.val && f3.val.sent === true && o2.uid() === uid, 'after a reload the refresh token is used (same uid) and the send works', f3);
    t = await call((cb) => o2.top(cb));
    chk((t.val || []).some((x) => x.id === uid && x.score === 7000), 'shared board shows 7000 for the same uid');
  }
  {
    /* an invalid refresh token: the client signs up again, once, and the send still works */
    const store = new Map();
    store.set('matatuRush.auth', JSON.stringify({ uid: 'deadbeefdeadbeefdeadbeef0000', refreshToken: 'not-a-real-token' }));
    store.set('matatuRush.onlineBest', '99999');
    const MR = boot(store); const o = MR.online;
    o.queue({ name: 'Konda 404', alias: 'Konda 404', score: 100000 });
    const f = await call((cb) => o.flush(cb));
    const auth = readMap(store, 'matatuRush.auth');
    chk(!f.err && f.val && f.val.sent === true && auth && auth.uid !== 'deadbeefdeadbeefdeadbeef0000', 'invalid refresh token: signs up again and the send works with the new uid', { f, uid: auth && auth.uid });
  }
  {
    /* a 403 is kept, not dropped: it can mean "too soon". The retry (11 s after the answer) first re-reads the server copy;
       the server holds more than the pending score, so the record is then cleared without sending anything. */
    const store = new Map(); const MR = boot(store); const o = MR.online;
    o.queue({ name: 'Konda 500', alias: 'Konda 500', score: 9000 });
    let f = await call((cb) => o.flush(cb));
    chk(!f.err, 'setup: 9000 accepted');
    /* same uid and tokens, but pretend local state was wiped: the server holds 9000, this one is lower */
    store.set('matatuRush.onlineBest', '0'); store.set('matatuRush.lastSend', '0');
    store.set('matatuRush.pending', JSON.stringify({ name: 'Konda 500', alias: 'Konda 500', score: 100 }));
    const MR2 = boot(store); const o2 = MR2.online;
    f = await call((cb) => o2.flush(cb));
    const kept = readMap(store, 'matatuRush.pending');
    chk(f.err === 'retry' && !!kept && kept.score === 100 && kept.attempts === 1, 'a 403 keeps the pending record and counts the attempt (attempts 1), it is not dropped', { f, kept });
    chk(!!(parseInt(store.get('matatuRush.lastSend'), 10) > 0), 'the send time is stored when the answer arrives');
    const okd = await until(() => o2.pending() === null, 16000);
    chk(okd && o2.best() === 9000, 'after 11 s the retry re-reads the server copy (9000 > 100), clears the record without sending, and resyncs onlineBest', { best: o2.best(), pending: o2.pending() });
    const f2 = await call((cb) => o2.flush(cb));
    chk(!f2.err && f2.val && f2.val.sent === false, 'nothing is sent afterwards');
  }
  {
    /* the reviewer's repro: another tab (here: a copy that does not know the send time) wrote 500; this one sends 900 at once */
    const sA = new Map(); const A = boot(sA).online;
    A.queue({ name: 'Tab Ay', alias: 'Tab Ay', score: 500 });
    const fa = await call((cb) => A.flush(cb));
    chk(!fa.err && fa.val.sent === true, 'two tabs: tab A sends 500');
    const uid = A.uid();
    const sB = new Map(); sB.set('matatuRush.auth', sA.get('matatuRush.auth'));
    const B = boot(sB).online;
    B.queue({ name: 'Tab Bee', alias: 'Tab Bee', score: 900 });
    const fb = await call((cb) => B.flush(cb));
    const kb = readMap(sB, 'matatuRush.pending');
    chk(fb.err === 'retry' && !!kb && kb.score === 900 && kb.attempts === 1, 'two tabs: B is told "too soon" (403) and KEEPS its 900', { fb, kb });
    const done = await until(() => B.pending() === null, 16000);
    const tt = await call((cb) => B.top(cb));
    chk(done && B.best() === 900 && (tt.val || []).some((x) => x.id === uid && x.score === 900 && x.name === 'Tab Bee'), 'two tabs: the retry goes out 11 s after the answer and the 900 lands on the server', { best: B.best(), rows: tt.val });
  }
  {
    /* two tabs that share storage (the real case): the send time is shared, so B waits instead of being refused */
    const sS = new Map(); const A = boot(sS).online;
    A.queue({ name: 'Shared A', alias: 'Shared A', score: 500 });
    await call((cb) => A.flush(cb));
    const B = boot(sS).online;
    chk(B.best() === 500, 'shared storage: tab B sees onlineBest 500 written by tab A');
    B.queue({ name: 'Shared B', alias: 'Shared B', score: 900 });
    const t0 = Date.now();
    const fb = await call((cb) => B.flush(cb));
    chk(!fb.err && fb.val.sent === true && Date.now() - t0 >= 9000 && B.pending() === null, 'shared storage: tab B waits for the window (stored send time) and is accepted, nothing is lost', { fb, waited: Date.now() - t0 });
  }
  {
    const store = new Map(); const MR = boot(store, { cfg: { projectId: PROJECT, apiKey: 'k', authBase: 'http://127.0.0.1:1/x', tokenBase: 'http://127.0.0.1:1/y', fsBase: 'http://127.0.0.1:1' } }); const o = MR.online;
    o.queue({ name: 'Konda 600', alias: 'Konda 600', score: 1200 });
    const f = await call((cb) => o.flush(cb));
    chk(f.err === 'net' && o.pending() && o.pending().score === 1200, 'network failure keeps the pending record', f);
    const t = await call((cb) => o.top(cb));
    chk(t.err === 'net', 'top() reports a network error', t);
  }
  console.log('\nREAL CLIENT: ' + e2e.passed + '/' + e2e.total + ' passed');

  const allOk = failures.length === 0 && e2e.fails.length === 0;
  console.log('\nTOTAL: ' + (passed + e2e.passed) + '/' + (total + e2e.total) + ' passed (rules ' + passed + '/' + total + ', real client ' + e2e.passed + '/' + e2e.total + ')');
  if (!allOk) { console.log('FAILED:\n' + failures.concat(e2e.fails).map((f) => ' - ' + f).join('\n')); process.exit(1); }
})().catch((e) => { console.error('RULES TEST CRASHED:', e); process.exit(3); });

#!/usr/bin/env node
/* Matatu Rush: end to end browser verification (Playwright + system Chrome, file:// only).
   Everything is driven through real keyboard / touch events. State is only ever READ, through
   window.MatatuRush.snapshot() and .events(). Nothing is injected into the game.

   Run:  node tests/run-tests.cjs
   Env:  PLAYWRIGHT_PATH=/path/to/node_modules/playwright  (optional)
         HEADED=1 (optional, watch it run) */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const SHOTS = path.join(OUT, 'screenshots');
const URL = 'file://' + path.join(ROOT, 'index.html');
fs.mkdirSync(SHOTS, { recursive: true });

function loadPlaywright() {
  const cands = [process.env.PLAYWRIGHT_PATH, 'playwright', path.join(ROOT, 'node_modules', 'playwright'),
    '/home/box/claude-kits/vendor/herk-edit-kit/node_modules/playwright'].filter(Boolean);
  for (const c of cands) { try { return { pw: require(c), from: c }; } catch (e) { /* next */ } }
  console.error('Playwright not found. Set PLAYWRIGHT_PATH or run: npm i -D playwright (inside tests/)');
  process.exit(2);
}

const results = [];
const problems = { consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [], nonFileRequests: [] };
let pagesWatched = 0, requestsSeen = 0;

function check(group, name, ok, detail) {
  results.push({ group, name, ok: !!ok, detail: detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)) });
  console.log((ok ? '  PASS ' : '  FAIL ') + '[' + group + '] ' + name + (detail !== undefined ? '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function watch(page, label) {
  pagesWatched++;
  page.on('console', (m) => {
    if (m.type() === 'error') problems.consoleErrors.push({ page: label, text: m.text() });
    if (m.type() === 'warning') problems.consoleWarnings.push({ page: label, text: m.text() });
  });
  page.on('pageerror', (e) => problems.pageErrors.push({ page: label, text: String(e && e.message || e) }));
  page.on('requestfailed', (r) => problems.failedRequests.push({ page: label, url: r.url() }));
  page.on('request', (r) => {
    requestsSeen++;
    const u = r.url();
    if (!(u.startsWith('file://') || u.startsWith('data:') || u.startsWith('blob:') || u === 'about:blank')) problems.nonFileRequests.push({ page: label, url: u });
  });
}

const read = (page, since) => page.evaluate((n) => ({ s: window.MatatuRush.snapshot(), e: window.MatatuRush.events(n) }), since || 0);
const snap = async (page) => (await read(page, 1e9)).s;

async function waitFor(page, pred, timeout, label) {
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < timeout) {
    s = await snap(page);
    if (pred(s)) return s;
    await sleep(30);
  }
  throw new Error('timeout waiting for ' + label + ' (last mode ' + (s && s.mode) + ', tick ' + (s && s.tick) + ')');
}

/* ---------- a test-side driver that only looks at the snapshot and presses real inputs ---------- */
const LEN = { pothole: 0.6, askari: 0.36, boda: 1.0 };
function covers(e, l) {
  if (e.type === 'askari') return l >= e.lane && l < e.lane + e.span;
  if (e.type === 'boda') return Math.abs(e.x - l) < 0.75 || e.lane === l || (e.signal && e.lane + e.signal === l);
  return e.lane === l;
}
function live(e) { return !e.hit && !e.gone && !e.crashed && !e.scatter; }
function decide(s, mode, want) {
  const cur = s.player.lane, T = [Infinity, Infinity, Infinity, Infinity], Rw = [0, 0, 0, 0];
  let target = null;
  if (mode === 'seek' && s.player.invuln <= 0 && !s.horn.nitro) {
    for (const e of s.entities) {
      if (!want.has(e.type) || !live(e) || e.d < 0.95 || e.d > 9) continue;
      if (!target || e.d < target.d) target = e;
    }
  }
  for (const e of s.entities) {
    if (e === target) continue;
    if (LEN[e.type] !== undefined && live(e)) {
      const half = (LEN[e.type] + 1.5) / 2;
      if (e.d < -half) continue;
      const rel = Math.max(0.5, s.speed - (e.v || 0));
      const t = Math.max(0, (e.d - half - 0.15) / rel);
      for (let l = 0; l < 4; l++) if (covers(e, l) && t < T[l]) T[l] = t;
    } else if ((e.type === 'stage' || e.type === 'repair') && !e.taken && e.d > 0.2 && e.d < 9) {
      Rw[e.lane] += (mode === 'seek' ? 0 : 30 - e.d * 2);
    }
  }
  if (target) {
    let tl = target.lane;
    if (target.type === 'askari') tl = Math.max(target.lane, Math.min(target.lane + target.span - 1, cur));
    if (target.type === 'boda') tl = Math.round(target.x);
    if (tl === cur) return 0;
    return tl > cur ? 1 : -1;
  }
  let best = cur, bv = -1e9;
  for (let l = 0; l < 4; l++) {
    const v = (T[l] > 1.7 ? 100 : T[l] * 55) + Rw[l] - Math.abs(l - cur) * 4;
    if (v > bv) { bv = v; best = l; }
  }
  if (best === cur) return 0;
  const dir = best > cur ? 1 : -1;
  if (s.horn.nitro || T[cur + dir] > 0.3 || T[cur + dir] >= T[cur]) return dir;
  return 0;
}

async function drive(page, opt) {
  const t0 = Date.now(), evs = [], seenTypes = new Set(), passed = new Set();
  let since = opt.since || 0, s = null;
  while (Date.now() - t0 < opt.ms) {
    const r = await read(page, since);
    s = r.s;
    for (const x of r.e) { evs.push(x); since = x.i; }
    for (const e of s.entities) {
      seenTypes.add(e.type);
      if (LEN[e.type] !== undefined && !e.hit && e.d < -1.3) passed.add(e.id);
    }
    if (opt.onTick) { const res = await opt.onTick(s, r.e, evs); if (res === 'stop') break; }
    if (s.mode !== 'running') break;
    const dir = decide(s, opt.mode || 'play', opt.want || new Set());
    if (dir) await opt.steer(dir);
    await sleep(22);
  }
  return { evs, s, seenTypes, passed, since };
}

/* the Top 5 name box takes focus on a qualifying game over; Escape inside it is Skip and moves focus to Play again */
async function skipNameIfShown(page) {
  /* closing the form starts a 600 ms input guard on Play again, so wait it out */
  if (await page.isVisible('#nameForm')) { await page.keyboard.press('Escape'); await sleep(680); }
}

/* ---------- Top 5 board: pure Node harness around js/core.js + js/game.js (no browser) ---------- */
function boardHarness(initial) {
  const store = Object.assign({}, initial || {});
  const win = { location: { search: '' }, localStorage: { getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }, setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } } };
  win.window = win;
  const ctx = vm.createContext(win);
  for (const f of ['js/core.js', 'js/game.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx);
  const g = win.MR.createGame();
  const evs = [];
  g.onEvent = (e) => evs.push(JSON.parse(JSON.stringify(e)));
  const crash = (seed, auto) => { evs.length = 0; g.start(seed, !!auto); while (g.mode === 'running' && g.tick < 400000) g.step(); return evs.find((e) => e.type === 'gameover'); };
  return { store, g, evs, crash };
}
function boardNodeChecks() {
  const G = 'board';
  const KEY = 'matatuRush.top5', ALIAS = /^(Dere|Konda|Makanga|Rubani) [1-9]\d\d$/;
  let h = boardHarness();
  let over = h.crash(3);
  let b = h.g.board();
  check(G, 'node: first qualifying run is inserted at once under an alias (matatu-crew word + 3 digits, max 12 chars) with rank 1', !!over && over.rank === 1 && h.g.boardRank === 1 && b.length === 1 && ALIAS.test(b[0].name) && b[0].name.length <= 12 && b[0].score === over.score && over.score > 0 && b[0].id === h.g.boardId && JSON.parse(h.store[KEY]).length === 1, { rank: over && over.rank, board: b });
  const firstId = b[0].id;
  over = h.crash(3);
  b = h.g.board();
  check(G, 'node: equal scores keep the older entry above (tie goes below)', over.rank === 2 && b.length === 2 && b[0].id === firstId && b[1].id === h.g.boardId && b[0].score === b[1].score);
  const sn = h.g.snapshot();
  check(G, 'node: snapshot carries a copy of the board and the run rank; board() returns copies', sn.boardRank === 2 && sn.board.length === 2 && (() => { const c = h.g.board(); c[0].name = 'HACK'; sn.board[0].name = 'HACK'; return h.g.board()[0].name !== 'HACK'; })());
  for (let sd = 1; sd <= 9; sd++) h.crash(sd);
  b = h.g.board();
  check(G, 'node: after many runs the board never exceeds 5 entries and stays sorted by score, high to low', b.length === 5 && b.every((e, i) => i === 0 || b[i - 1].score >= e.score) && JSON.parse(h.store[KEY]).length === 5, b.map((e) => e.score));
  /* a run that cannot beat the 5th place must not enter */
  h = boardHarness({ [KEY]: JSON.stringify([1, 2, 3, 4, 5].map((n) => ({ name: 'P' + n, score: 999999999 - n, id: 'p' + n }))) });
  const beforeHigh = h.store[KEY];
  over = h.crash(4);
  check(G, 'node: a score below the 5th place gets no entry, rank 0, board untouched', over.rank === 0 && h.g.boardRank === 0 && h.g.boardId === null && h.store[KEY] === beforeHigh && h.g.board().length === 5, { rank: over.rank });
  h = boardHarness();
  over = h.crash(3, true);
  check(G, 'node: an autopilot demo run never adds an entry', over.rank === 0 && h.g.board().length === 0 && h.store[KEY] === undefined, { rank: over.rank });
  h = boardHarness({ 'matatuRush.best': '5000' });
  check(G, 'node: migration: a stored best with an empty board does not invent an entry and best stays as is', h.g.board().length === 0 && h.g.best === 5000 && h.store[KEY] === undefined);
  const hz = (raw) => boardHarness({ [KEY]: raw }).g.board();
  const messy = hz(JSON.stringify([1, 'x', null, { name: 5, score: 10 }, { name: '  Bob  ', score: 10.7, id: 'a' }, { name: 'A very long name indeed', score: 20, id: 'b' }, { name: 'Z', score: -1 }, { name: 'Q', score: 'NaN' }, { name: '   ', score: 99 }]));
  check(G, 'node: bad JSON and wrong shapes give an empty board; bad entries are dropped; names trimmed to 12; scores whole numbers above 0', hz('not json').length === 0 && hz('{"a":1}').length === 0 && hz('null').length === 0 && hz('"str"').length === 0 && messy.length === 2 && messy[0].name === 'A very long' && messy[1].name === 'Bob' && messy[1].score === 10, messy);
  h = boardHarness();
  h.crash(3);
  const id = h.g.boardId, alias = h.g.board()[0].name;
  const r1 = h.g.setBoardName(id, '   Mr    Fast   Driver Long  ');
  const r2 = h.g.setBoardName(id, '    ');
  const r3 = h.g.setBoardName('nope', 'X');
  check(G, 'node: setBoardName trims, collapses spaces, caps at 12; empty keeps the stored name; unknown id returns an empty string', r1 === 'Mr Fast Driv' && r1.length <= 12 && r2 === 'Mr Fast Driv' && r3 === '' && JSON.parse(h.store[KEY])[0].name === 'Mr Fast Driv' && alias !== r1, { r1, r2, r3 });
  const a = boardHarness(), c = boardHarness({ [KEY]: JSON.stringify([{ name: 'Old', score: 1, id: 'o1' }]) });
  const strip = (e) => JSON.stringify(e.filter((x) => x.type !== 'gameover'));
  a.crash(3); c.crash(3);
  check(G, 'node: the board does not touch the seeded game RNG: same seed gives the same non-final events whether the board is empty or not', strip(a.evs) === strip(c.evs) && a.evs.length > 5 && c.g.boardRank === 1 && a.g.boardRank === 1);
}

/* ---------- OVERLAP (second power): Node-level simulation checks, no browser ---------- */
function simHarness() {
  const win = { location: { search: '' }, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } };
  win.window = win;
  const ctx = vm.createContext(win);
  for (const f of ['js/core.js', 'js/game.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx);
  const MR = win.MR, g = MR.createGame(), evs = [];
  g.onEvent = (e) => evs.push(JSON.parse(JSON.stringify(e)));
  return { MR, g, evs, C: MR.CONST };
}
/* a hand-built road: random rows are switched off and the test places every entity itself */
function overlapScene(seed) {
  const h = simHarness(), g = h.g, evs = h.evs;
  g.start(seed || 5, false);
  g.nextRowAt = Infinity; g.ents.length = 0;
  let nid = 9000;
  const S = Object.assign({}, h, {
    step(n) { for (let i = 0; i < n && g.mode === 'running'; i++) g.step(); },
    secs(t) { S.step(Math.round(t / h.C.STEP)); },
    until(pred, max) { let i = 0; while (!pred() && i++ < (max || 6000) && g.mode === 'running') g.step(); return pred(); },
    add(e) { e.id = nid++; g.ents.push(e); return e; },
    stage(lane, d) { return S.add({ type: 'stage', lane, d, pax: 2, taken: false }); },
    pothole(lane, d) { return S.add({ type: 'pothole', lane, d, shape: 1 }); },
    askari(lane, d) { return S.add({ type: 'askari', lane, span: 2, d }); },
    boda(lane, d, v) { return S.add({ type: 'boda', kind: 'cruiser', lane, x: lane, d, v: v || 2.5, signal: 0, signalT: 0, weaveT: 99, spin: 0, vx: 0 }); },
    repair(lane, d) { return S.add({ type: 'repair', lane, d }); },
    pickup() { const n = g.stats.pickups; S.stage(g.lane, 2); S.until(() => g.stats.pickups > n, 1500); },
    charge() { let n = 0; while (g.overlap < 1 && n < 40) { S.pickup(); n++; } return n; },
    count(type, from) { return evs.slice(from || 0).filter((e) => e.type === type); }
  });
  return S;
}
/* captured from the simulation as it was before OVERLAP existed, with only the current speed tuning (MAX_SPEED 15, SPEED_RAMP 0.010) applied: autopilot, 120 s of sim time or game over */
const AUTOPILOT_BASELINE = {
  7: { rows: { 1200: [807, 57.2004, 3, 1, 1, 5, 5], 6000: [10746, 386.1872, 3, 2, 2, 26, 21], 12000: [17998, 1068.423, 2, 0, 0, 46, 1] }, final: [14400, 23948, 1418.4237618765258, 2, 'running'], events: 226, md5: '167d65b39127f2e07409af4f7c8bdcbc' },
  42: { rows: { 1200: [2367, 67.5274, 3, 1, 1, 7, 7], 6000: [15452, 402.1132, 3, 1, 1, 32, 6], 12000: [35343, 1168.6424, 1, 0, 0, 72, 7] }, final: [12270, 35677, 1202.8711460128172, 0, 'gameover'], events: 251, md5: '5445cd2394c9ff9ab174b4503f1b2851' }
};
function overlapNodeChecks() {
  const G = 'overlap', crypto = require('crypto');
  let S = overlapScene(), g = S.g, C = S.C;
  const hitTotal = () => g.stats.hits.pothole + g.stats.hits.boda + g.stats.hits.askari;

  /* --- meter: starts empty, only pickups fill it --- */
  const sn0 = g.snapshot().overlap;
  check(G, 'node: the meter starts EMPTY (the horn starts full) and a run starts with no uses', g.overlap === 0 && g.horn === 1 && sn0.meter === 0 && sn0.ready === false && sn0.active === false && sn0.time === 0 && sn0.uses === 0 && g.stats.overlaps === 0, sn0);
  S.secs(30);
  S.pothole(1, 3.0);
  S.until(() => g.ents[0].d < 1.5, 3000);
  g.input('left', 'keyboard');
  S.secs(1.5);
  check(G, 'node: 30 s of driving and a near miss (RADA bonus) leave the meter at 0: only passenger pickups fill it', g.overlap === 0 && g.stats.nearMiss >= 1 && g.stats.pickups === 0 && S.count('overlapReady').length === 0, { nearMiss: g.stats.nearMiss, meter: g.overlap });

  S = overlapScene(); g = S.g;
  const marks = [];
  for (let k = 1; k <= 8; k++) { S.pickup(); marks.push(g.overlap); }
  const rdy = S.count('overlapReady');
  check(G, 'node: the first charge takes exactly 8 pickups (0.125 each); overlapReady fires once, on the 8th', marks.every((m, i) => m === (i + 1) * 0.125) && g.stats.pickups === 8 && rdy.length === 1 && g.snapshot().overlap.ready === true, { marks, ready: rdy.length });
  S.pickup();
  check(G, 'node: a 9th pickup with a full meter keeps it at 1 and does not announce ready again', g.overlap === 1 && S.count('overlapReady').length === 1);

  /* --- each charge fills 12 percent slower than the one before (compounding) --- */
  S = overlapScene(); g = S.g;
  const need = [], per = [], readyFlags = [];
  for (let use = 0; use < 3; use++) {
    const before = g.overlap;
    S.pickup(); per.push(g.overlap - before);
    need.push(1 + S.charge());
    readyFlags.push(g.overlap >= 1 && g.snapshot().overlap.ready && g.input('overlap', 'keyboard'));
    S.secs(C.OVERLAP_TIME + 0.2);
  }
  const want1 = 0.125, want2 = 0.125 * 0.88, want3 = 0.125 * 0.88 * 0.88;
  check(G, 'node: fill per pickup is 0.125 on the first charge, 0.88x of that after 1 use (0.11), 0.88^2 after 2 uses (0.0968)', Math.abs(per[0] - want1) < 1e-12 && Math.abs(per[1] - want2) < 1e-12 && Math.abs(per[2] - want3) < 1e-12 && Math.abs(want2 - 0.11) < 1e-12 && Math.abs(want3 - 0.0968) < 1e-12, per);
  check(G, 'node: so the pickups needed grow 8, 10, 11 (1 / (0.125 * 0.88^uses), rounded up) and every charge can be fired', need.join(',') === '8,10,11' && readyFlags.every((x) => x === true) && g.overlapUses === 3 && g.stats.overlaps === 3, need);

  /* --- input rules --- */
  S = overlapScene(); g = S.g;
  let from = S.evs.length;
  const r0 = g.input('overlap', 'touch');
  const emp = S.count('overlapEmpty', from);
  check(G, 'node: overlap input when not ready does nothing but emit overlapEmpty', r0 === false && emp.length === 1 && emp[0].reason === 'charging' && emp[0].source === 'touch' && S.count('overlap', from).length === 0 && g.overlapTime === 0 && g.overlapUses === 0 && g.stats.overlaps === 0);
  S.charge();
  g.input('horn', 'keyboard');
  const nitroOn = g.nitro > 0, rdyDuringNitro = g.snapshot().overlap.ready;
  from = S.evs.length;
  const r1 = g.input('overlap', 'keyboard');
  const e1 = S.count('overlapEmpty', from);
  check(G, 'node: overlap cannot start during nitro (meter kept, overlapEmpty says why)', nitroOn && r1 === false && !rdyDuringNitro && e1.length === 1 && e1[0].reason === 'nitro' && g.overlap === 1 && g.overlapUses === 0 && g.overlapTime === 0, e1);
  S.secs(C.NITRO_TIME + 0.2);
  check(G, 'node: once nitro has ended the full meter fires', g.nitro === 0 && g.input('overlap', 'keyboard') === true && g.overlapTime > 0 && g.overlap === 0);

  S = overlapScene(); g = S.g;
  S.charge();
  g.input('overlap', 'keyboard');
  const hornBefore = g.horn; from = S.evs.length;
  const hr = g.input('horn', 'keyboard');
  const he = S.count('hornEmpty', from), hornAfter = g.horn;
  check(G, 'node: the horn is refused during overlap and the horn meter is not spent', hr === false && he.length === 1 && he[0].reason === 'overlap' && hornBefore === 1 && hornAfter === 1 && g.nitro === 0 && g.stats.horns === 0 && S.count('horn', from).length === 0);
  S.secs(C.OVERLAP_TIME + 0.2);
  check(G, 'node: after the overlap the horn meter is still full and the horn fires', g.horn === 1 && g.input('horn', 'keyboard') === true && g.nitro > 0);

  /* --- during overlap nothing can touch the matatu --- */
  const gauntlet = (S2) => {
    const items = { stage: [], repair: [], block: [] };
    for (const d of [3, 9, 15]) for (let l = 0; l < 4; l++) items.block.push(S2.pothole(l, d + l * 0.05));
    items.block.push(S2.askari(0, 6), S2.askari(2, 12));
    items.block.push(S2.boda(0, 4), S2.boda(1, 7), S2.boda(3, 8, 2.0));
    /* point blank, right on top of the matatu at the moment it leaves the road: the eased exit must not collide or collect */
    items.block.push(S2.pothole(1, 0.4), S2.pothole(0, 0.6), S2.boda(1, 0.3, 2.5));
    items.stage.push(S2.stage(1, 5), S2.stage(0, 10), S2.stage(0, 3.5), S2.stage(1, 0.2));
    items.repair.push(S2.repair(0, 13));
    return items;
  };
  S = overlapScene(); g = S.g;
  gauntlet(S);
  S.secs(6);
  check(G, 'node: control run: the same gauntlet (every lane blocked, askari, bodas) really does hurt a matatu that stays on the road', hitTotal() >= 1 && g.health < C.MAX_HEALTH, { hits: g.stats.hits, health: g.health });

  S = overlapScene(); g = S.g;
  S.charge();
  S.secs(0.3);
  g.lane = 1; g.px = 1;
  const pick0 = g.stats.pickups, laneChanges0 = g.stats.laneChanges;
  g.input('overlap', 'keyboard');
  const combo0 = g.combo, timer0 = g.comboTimer, score0 = g.score, startEv = S.evs.length;
  const gt = gauntlet(S);
  const inputsBefore = S.evs.length;
  const lr = [g.input('left', 'keyboard'), g.input('right', 'keyboard'), g.input('left', 'touch')];
  S.secs(0.6);
  const settledPx = g.px;
  lr.push(g.input('right', 'keyboard'));
  S.secs(C.OVERLAP_TIME - 0.65);
  const preEnd = { active: g.overlapTime > 0, health: g.health };
  S.until(() => S.count('overlapEnd').length > 0, 400);
  const evAfter = S.evs.slice(startEv);
  const bad = evAfter.filter((e) => /^(hit|smash|nearMiss|pickup|repair|comboEnd|gameover|lane|bump)$/.test(e.type));
  check(G, 'node: during overlap: bodas, potholes, an askari checkpoint and a fully blocked road cost zero health, zero hits, no smash, no near-miss credit, no game over', preEnd.active && g.health === C.MAX_HEALTH && hitTotal() === 0 && bad.length === 0 && g.mode === 'running' && S.count('overlapEnd').length === 1, { bad: bad.slice(0, 4), hits: g.stats.hits, health: g.health });
  check(G, 'node: during overlap nothing is collected (stage and fundi items stay untaken) and the combo does not change', g.stats.pickups === pick0 && gt.stage.every((s) => !s.taken) && gt.repair.every((s) => !s.taken) && g.combo === combo0 && g.comboTimer === timer0 && g.stats.repairs === 0, { combo: g.combo, combo0, timer: g.comboTimer, timer0 });
  check(G, 'node: lane inputs are ignored while overlapping (no lane change, no event, no bump), and the matatu parks one lane outside the left edge (px -1)', lr.every((x) => x === false) && g.stats.laneChanges === laneChanges0 && Math.abs(settledPx - (-1)) < 0.001 && evAfter.filter((e) => e.type === 'lane' || e.type === 'bump').length === 0, { lr, settledPx });

  /* --- the end: edge lane, invulnerability, no unfair hit on re-entry --- */
  S = overlapScene(); g = S.g;
  S.charge();
  g.lane = 1; g.px = 1;
  g.input('overlap', 'keyboard');
  const tStart = S.count('overlap')[0].t;
  S.until(() => g.overlapTime < 0.03, 1000);
  const merge = [S.pothole(0, 1.25), S.askari(0, 2.6), S.boda(0, 3.4), S.pothole(1, 2.2)];
  S.until(() => S.count('overlapEnd').length > 0, 400);
  const endEv = S.count('overlapEnd')[0], invAtEnd = g.invuln, laneAtEnd = g.lane, healthAtEnd = g.health;
  S.secs(0.9);
  const hitsIn09 = S.evs.filter((e) => e.type === 'hit');
  S.secs(2.5);
  check(G, 'node: overlap lasts OVERLAP_TIME (4.0 s), then the lane becomes the edge lane on that side (left: lane 0) and overlapEnd is emitted', Math.abs((endEv.t - tStart) - C.OVERLAP_TIME) < 0.02 && endEv.lane === 0 && endEv.side === -1 && laneAtEnd === 0 && g.overlapTime === 0 && g.snapshot().overlap.active === false, { dt: endEv.t - tStart, lane: laneAtEnd });
  check(G, 'node: the merge grants 0.9 s of invulnerability and obstacles waiting in the re-entry lane cannot hurt (no hit, no health lost, now or later)', invAtEnd >= 0.89 && merge.slice(0, 3).some((e) => e.hit === true) && hitsIn09.length === 0 && hitTotal() === 0 && g.health === healthAtEnd && g.mode === 'running', { invAtEnd, hit: merge.map((e) => !!e.hit), hits: hitsIn09.length });

  /* --- no near-miss credit for obstacles ghosted past on the shoulder, even with a lane change right after the merge --- */
  S = overlapScene(); g = S.g;
  S.charge(); g.lane = 1; g.px = 1;
  g.input('overlap', 'keyboard');
  S.until(() => g.overlapTime > 0 && g.overlapTime < 0.15, 1000);
  const ghost = { pothole: S.pothole(0, 0.2), askari: S.askari(0, 0.5), boda: S.boda(0, 0.9, 2.5) };
  S.until(() => S.count('overlapEnd').length > 0, 400);
  const ghostNm0 = g.stats.nearMiss, ghostScore0 = g.score, ghostHorn0 = g.horn, ghostEv0 = S.evs.length;
  g.input('right', 'keyboard');
  S.secs(1.5);
  const ghostIds = [ghost.pothole.id, ghost.askari.id, ghost.boda.id];
  const ghostNm = S.evs.slice(ghostEv0).filter((e) => e.type === 'nearMiss' && ghostIds.indexOf(e.id) >= 0);
  check(G, 'node: obstacles passed on the shoulder (pothole, askari, boda) earn no near-miss after the merge, even with a lane change right after: no event, no stat, no horn bonus', ghostNm.length === 0 && g.stats.nearMiss === ghostNm0 && hitTotal() === 0 && g.horn <= ghostHorn0, { ghostNm, nearMiss: g.stats.nearMiss, ghostNm0, score: g.score, ghostScore0, horn: g.horn, ghostHorn0 });

  /* --- fairness: a boda may not cut into the lane the matatu will merge back into --- */
  S = overlapScene(); g = S.g;
  S.charge(); g.lane = 1; g.px = 1;
  g.input('overlap', 'keyboard');
  const cutter = S.boda(1, 2.5, 2.5); cutter.signal = -1; cutter.signalT = 0.01;
  S.secs(0.1);
  check(G, 'node: fairness: a boda that signals into the re-entry lane (lane 0) at close range is held back while the matatu is on the left shoulder', cutter.lane === 1 && cutter.signal === 0, { lane: cutter.lane, signal: cutter.signal });

  /* --- side choice --- */
  const sides = [];
  for (let l = 0; l < 4; l++) {
    S = overlapScene(); g = S.g;
    g.lane = l; g.px = l; g.overlap = 1; g.overlapReadyFlag = true;
    g.input('overlap', 'keyboard');
    const side = g.overlapSide, ev = S.count('overlap')[0];
    S.secs(0.7);
    const px = g.px;
    S.secs(C.OVERLAP_TIME);
    sides.push({ l, side, evSide: ev.side, px: Math.round(px * 100) / 100, endLane: g.lane });
  }
  check(G, 'node: side choice: lanes 0 and 1 go left (px -1, merge into lane 0); lanes 2 and 3 go right (px 4, merge into lane 3)', sides.every((x) => x.side === (x.l <= 1 ? -1 : 1) && x.evSide === x.side && x.px === (x.l <= 1 ? -1 : 4) && x.endLane === (x.l <= 1 ? 0 : 3)), sides);

  /* --- pause and resume --- */
  S = overlapScene(); g = S.g;
  S.charge(); g.input('overlap', 'keyboard');
  S.secs(1.5);
  const tl = g.overlapTime, tick = g.tick;
  g.mode = 'paused'; S.step(2000);
  const pr = g.input('overlap', 'keyboard');
  const frozen = g.overlapTime === tl && g.tick === tick && pr === false;
  g.mode = 'running'; S.secs(1);
  check(G, 'node: pause freezes the overlap and resume carries on from the same time left', frozen && Math.abs(g.overlapTime - (tl - 1)) < 0.02 && g.overlapUses === 1 && g.snapshot().overlap.active, { tl, now: g.overlapTime });

  /* --- determinism --- */
  S = overlapScene(); g = S.g;
  let rngCalls = 0; const orig = g.rng; g.rng = () => { rngCalls++; return orig(); };
  S.charge(); g.input('overlap', 'keyboard'); g.input('horn', 'keyboard'); S.secs(C.OVERLAP_TIME + 1);
  check(G, 'node: charging, firing, riding and ending an overlap never touch the seeded rng (0 calls)', rngCalls === 0 && g.overlapUses === 1, { rngCalls });

  for (const seed of [7, 42]) {
    const h = simHarness(), a = h.g, base = AUTOPILOT_BASELINE[seed];
    a.start(seed, true);
    const types = [], rows = {};
    a.onEvent = (e) => types.push(e.type + '@' + e.tick);
    while (a.mode === 'running' && a.time < 120) { a.step(); if (a.tick % 600 === 0) rows[a.tick] = [a.score, +a.dist.toFixed(4), a.health, a.lane, +a.px.toFixed(4), a.stats.pickups, a.combo]; }
    const kept = types.filter((x) => !x.startsWith('overlapReady@'));
    const md5 = crypto.createHash('md5').update(kept.join(',')).digest('hex');
    const never = !types.some((x) => /^overlap(@|End|Empty)/.test(x)) && a.stats.overlaps === 0 && a.overlapUses === 0 && a.overlapTime === 0;
    const sameRows = Object.keys(base.rows).every((k) => JSON.stringify(rows[k]) === JSON.stringify(base.rows[k]));
    const fin = [a.tick, a.score, a.dist, a.health, a.mode];
    check(G, 'node: seed ' + seed + ' autopilot never uses overlap, and its score / distance / health / lane trace and event sequence are identical to the run captured BEFORE overlap existed (overlapReady notices aside)', never && sameRows && JSON.stringify(fin) === JSON.stringify(base.final) && kept.length === base.events && md5 === base.md5, { never, sameRows, fin, events: kept.length, md5 });
  }
}

const keySteer = (page) => (dir) => page.keyboard.press(dir < 0 ? 'ArrowLeft' : 'ArrowRight');

function validHitGeometry(ev) {
  const hw = ev.kind === 'askari' ? 0.96 : (ev.kind === 'boda' ? 0.25 : 0.28);
  const lat = Math.abs(ev.px - ev.entX) < hw + 0.3 - 0.08 + 0.02;
  const lon = Math.abs(ev.d) < (LEN[ev.kind] + 1.5) / 2 - 0.12 + 0.02;
  return lat && lon;
}

/* ---------- Node replay of the same simulation (cross-check for browser events) ---------- */
function nodeReplay(seed, maxTick) {
  const win = { location: { search: '' }, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } };
  win.window = win;
  const ctx = vm.createContext(win);
  for (const f of ['js/core.js', 'js/game.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx);
  const g = win.MR.createGame();
  g.start(seed, true);
  while (g.mode === 'running' && g.tick < maxTick) g.step();
  return JSON.parse(JSON.stringify(g.log.filter((e) => e.tick <= maxTick)));
}

/* ---------- round 2 additions: short screens, banner placement, near-miss and repair ---------- */
const rectsOverlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

async function smallScreenChecks(browser) {
  const sizes = [[320, 568, true], [360, 640, true], [844, 390, true], [390, 844, true], [1280, 720, false]];
  for (const [w, h, touch] of sizes) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 2 : 1 });
    const page = await ctx.newPage(); watch(page, 'small-' + w + 'x' + h);
    await page.goto(URL + '?seed=7');
    await page.waitForFunction(() => !!window.MatatuRush);
    await fontsReady(page);
    await sleep(300);
    const fit = await page.evaluate(() => {
      const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height) }; };
      const inView = (b) => b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth;
      const st = box('btnStart'), demo = box('btnDemo'), mute = box('btnMute');
      return { scrollTop: document.getElementById('title').scrollTop, start: st, startIn: inView(st), demoIn: inView(demo), muteIn: inView(mute), startH: st.h, vh: innerHeight, sw: document.documentElement.scrollWidth, vw: innerWidth };
    });
    check('small', w + 'x' + h + ' title: Start fully on screen with no scrolling, at least 44 px tall, no sideways scroll',
      fit.scrollTop === 0 && fit.startIn && fit.startH >= 44 && fit.sw <= fit.vw, { startTop: fit.start.top, startBottom: fit.start.bottom, vh: fit.vh });
    if (h <= 640) check('small', w + 'x' + h + ' title: Watch demo and Sound buttons are also on screen without scrolling', fit.demoIn && fit.muteIn);
    if (w === 320 || w === 844) {
      await page.screenshot({ path: path.join(SHOTS, (w === 320 ? '08-title-320x568' : '09-title-844x390') + '.png') });
      /* start by a real tap at the un-scrolled position, then look at the opening banner */
      await page.touchscreen.tap((fit.start.left + fit.start.right) / 2, (fit.start.top + fit.start.bottom) / 2);
      const s = await waitFor(page, (x) => x.mode === 'running' && x.view.banner, 3000, 'banner ' + w);
      const v = s.view, b = v.banner, road = { x: v.roadX, y: v.hudBottom + 0.6 * v.unit, w: v.roadW, h: v.h };
      const lay = await page.evaluate(() => { const r = (id) => { const q = document.getElementById(id).getBoundingClientRect(); return q.top >= 0 && q.bottom <= innerHeight && q.left >= 0 && q.right <= innerWidth && q.width >= 44 && q.height >= 44; }; return r('btnLeft') && r('btnRight') && r('btnHorn') && r('btnPause'); });
      check('small', w + 'x' + h + ' play: a tap on the un-scrolled Start begins the run, controls on screen and at least 44 px', s.inputs !== undefined && lay, { zone: b.zone });
      check('banner', w + 'x' + h + ' banner (' + b.zone + ') stays out of the road ahead: no overlap with the road below the HUD strip',
        !rectsOverlap(b, road) && b.x >= 0 && b.x + b.w <= v.w && (b.zone === 'gutter' ? b.x + b.w <= v.roadX : b.h <= 0.9 * v.unit), { banner: b, roadX: v.roadX, hudBottom: v.hudBottom, unit: v.unit });
      await sleep(350);
      await page.screenshot({ path: path.join(SHOTS, (w === 320 ? '10-play-320x568' : '11-play-844x390') + '.png') });
    }
    await ctx.close();
  }
}

/* ---------- round 3 additions: popup overlap audit, font audit, layout, audio capture ---------- */
const fontsReady = (page) => page.evaluate(() => (document.fonts && document.fonts.ready) ? document.fonts.load('italic 900 20px "Barlow Condensed"').then(() => document.fonts.ready).then(() => true) : true);

function mkPopupAudit() { return { frames: 0, overlaps: [], both: 0, hornWithPickup: 0, slotSeen: 0, slotBad: [], hornInFloat: 0, floatOffRoad: 0, maxFloats: 0, copy: {} }; }
/* reads view.floats / view.slot / view.road / view.player from one snapshot; never writes anything */
function popupAudit(s, a) {
  const v = s.view, fl = v.floats || [];
  if (!fl.length && !v.slot) return null;
  a.frames++;
  a.maxFloats = Math.max(a.maxFloats, fl.length);
  const all = fl.map((f) => Object.assign({ kind: 'float' }, f)).concat(v.slot ? [Object.assign({ kind: 'slot' }, v.slot)] : []);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    if (rectsOverlap(all[i], all[j]) && a.overlaps.length < 8) a.overlaps.push({ t: s.time, a: all[i], b: all[j] });
  }
  const fare = fl.some((f) => /^\+KSh/.test(f.text)), beba = fl.some((f) => /^BEBA!/.test(f.text));
  if (fare && beba) a.both++;
  for (const f of fl) {
    if (/HORN/.test(f.text)) a.hornInFloat++;
    if (f.x < v.road.x - 0.5 || f.x + f.w > v.road.x + v.road.w + 0.5 || f.w <= 0 || f.h <= 0) a.floatOffRoad++;
  }
  let horn = false;
  if (v.slot) {
    a.slotSeen++; a.copy[v.slot.text] = (a.copy[v.slot.text] || 0) + 1;
    const sl = v.slot;
    const bad = rectsOverlap(sl, v.road) || rectsOverlap(sl, v.player) || sl.x < v.road.x + v.road.w || sl.x + sl.w > v.w || sl.y < 0 || sl.y + sl.h > v.h;
    if (bad && a.slotBad.length < 5) a.slotBad.push({ t: s.time, slot: sl, road: v.road, player: v.player });
    horn = /^HORN READY!?$/.test(sl.text);
    if (horn && (fare || beba)) a.hornWithPickup++;
  }
  return { fare, beba, horn };
}

/* runs in the page: every visible text node must be set at 14 px or more */
const FONT_AUDIT = () => {
  const bad = []; let n = 0, min = 1e9;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let t;
  while ((t = w.nextNode())) {
    if (!t.nodeValue.trim()) continue;
    const el = t.parentElement;
    if (!el || el.closest('.sr, noscript, script, style')) continue;
    if (!el.getClientRects().length) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const fs = parseFloat(cs.fontSize); n++; if (fs < min) min = fs;
    if (fs < 14) bad.push({ text: t.nodeValue.trim().slice(0, 24), px: fs, on: el.id || el.className || el.tagName });
  }
  return { n, min, bad };
};
const fontAudit = (page) => page.evaluate(FONT_AUDIT);

/* Items 4 and 5 of the round 3 QC: text sizes, how-to-play never clipped, pause and mute off the
   right lane, a visible shop strip in portrait. Real clicks and keys only. */
async function layoutChecks(browser) {
  const sizes = [[320, 568, true, '20'], [844, 390, true, '30'], [390, 844, true, '40'], [1280, 720, false, '50']];
  for (const [w, h, touch, pre] of sizes) {
    const tag = w + 'x' + h;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 2 : 1 });
    const page = await ctx.newPage(); watch(page, 'layout-' + tag);
    await page.goto(URL + '?seed=7');
    await page.waitForFunction(() => !!window.MatatuRush);
    await fontsReady(page); await sleep(350);
    const clipInfo = (rootId, itemSel) => page.evaluate(([rootId, itemSel]) => {
      const root = document.getElementById(rootId);
      const items = Array.from(root.querySelectorAll(itemSel)).map((el) => { const r = el.getBoundingClientRect(); return { in: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5 && r.width > 0, clipped: el.scrollWidth > el.clientWidth + 1 || (/^(LI|BUTTON)$/.test(el.tagName) && el.scrollHeight > el.clientHeight + 1) }; });
      return { n: items.length, allIn: items.every((i) => i.in), noneClipped: items.every((i) => !i.clipped), scrolls: root.scrollHeight > root.clientHeight + 1, sideways: document.documentElement.scrollWidth > innerWidth };
    }, [rootId, itemSel]);
    const fam = await page.evaluate(() => ({ logo: getComputedStyle(document.querySelector('.l1')).fontFamily, body: getComputedStyle(document.body).fontFamily, barlow: document.fonts.check('italic 900 20px "Barlow Condensed"'), raj: document.fonts.check('700 16px "Rajdhani"'), loaded: Array.from(document.fonts).filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '') + ' ' + f.weight) }));
    if (pre === '50') check('fonts', 'bundled faces are loaded and in use: Barlow Condensed for display, Rajdhani for body', /^"?Barlow Condensed/.test(fam.logo) && /^"?Rajdhani/.test(fam.body) && fam.barlow && fam.raj && fam.loaded.some((f) => /Barlow/.test(f)) && fam.loaded.some((f) => /Rajdhani/.test(f)), fam.loaded);
    const tl = await clipInfo('title', '.legend li, .actions button, .logo, .tag, .bestline');
    const tf = await fontAudit(page);
    check('layout', tag + ' title: how-to-play icon row and every button fully on screen, nothing clipped, no scrolling', tl.n >= 9 && tl.allIn && tl.noneClipped && !tl.scrolls && !tl.sideways, tl);
    check('text', tag + ' title: every visible text is at least 14 px', tf.n > 8 && tf.bad.length === 0, { nodes: tf.n, min: tf.min, bad: tf.bad });
    await page.screenshot({ path: path.join(SHOTS, pre + '-' + tag + '-title.png') });
    await page.click('#btnHow'); await sleep(200);
    const hl = await clipInfo('howto', '.rules li, .rules li span, .keys, #btnHowClose, .h2');
    const hf = await fontAudit(page);
    check('layout', tag + ' How to play sheet: all five cards, controls and Close on screen, nothing clipped, no scrolling', hl.n >= 13 && hl.allIn && hl.noneClipped && !hl.scrolls, hl);
    check('text', tag + ' How to play sheet: every visible text is at least 14 px', hf.n > 10 && hf.bad.length === 0, { nodes: hf.n, min: hf.min, bad: hf.bad });
    await page.screenshot({ path: path.join(SHOTS, pre + '-' + tag + '-howto.png') });
    await page.keyboard.press('Escape'); await sleep(120);
    const closed = await page.evaluate(() => document.getElementById('howto').hidden && window.MatatuRush.snapshot().mode === 'title');
    await page.click('#btnStart');
    await waitFor(page, (x) => x.mode === 'running', 3000, 'layout run ' + tag);
    let gf = null, comboAudit = null, shot = false;
    const pa = mkPopupAudit();
    const run = await drive(page, {
      ms: 9000, mode: 'play', steer: keySteer(page),
      onTick: async (q) => {
        popupAudit(q, pa);
        if (!comboAudit && q.combo >= 2) comboAudit = await fontAudit(page);
        if (!shot && q.time > 4.2 && (q.view.floats.length || q.time > 7)) { shot = true; gf = await fontAudit(page); await page.screenshot({ path: path.join(SHOTS, pre + '-' + tag + '-play.png') }); }
        if (shot && comboAudit && q.time > 6) return 'stop';
      }
    });
    const s = run.s, v = s.view;
    const btn = await page.evaluate(() => { const r = (id) => { const q = document.getElementById(id).getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height }; }; return { pause: r('btnPause'), mute: r('btnMuteHud'), vw: innerWidth, vh: innerHeight }; });
    const inView = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= btn.vw && r.y + r.h <= btn.vh && r.w >= 44 && r.h >= 44;
    check('layout', tag + ' play: closing the sheet returned to the title and Start began the run', closed && s.time > 4, { time: s.time });
    check('layout', tag + ' play: pause and mute buttons do not cover the right lane (or any tarmac) and stay on screen at 44 px',
      !rectsOverlap(btn.pause, v.rightLane) && !rectsOverlap(btn.mute, v.rightLane) && !rectsOverlap(btn.pause, v.road) && !rectsOverlap(btn.mute, v.road) && inView(btn.pause) && inView(btn.mute) && !rectsOverlap(btn.pause, btn.mute),
      { pauseX: Math.round(btn.pause.x), muteX: Math.round(btn.mute.x), roadRight: v.road.x + v.road.w, rightLane: v.rightLane.x });
    const portrait = h > w;
    check('layout', tag + ' play: a shop strip is visible on both sides of the road' + (portrait ? ' in portrait (at least half a lane and 20 px each side)' : ''),
      v.shopsDrawn && v.shops.length === 2 && v.shops.every((r) => r.w === v.shopStrip) && v.shopStrip >= 0.5 * v.unit && v.shopStrip >= 20 && v.roadW < 0.6 * v.w, { shopStrip: v.shopStrip, unit: v.unit, roadX: v.roadX, roadW: v.roadW, w: v.w });
    check('text', tag + ' play: every visible HUD and control text is at least 14 px (combo chip included)', !!gf && gf.bad.length === 0 && !!comboAudit && comboAudit.bad.length === 0, { hud: gf && { nodes: gf.n, min: gf.min, bad: gf.bad }, combo: comboAudit && { min: comboAudit.min, bad: comboAudit.bad } });
    check('popup', tag + ' play: no two live floating popups overlap and all stay within the road width', pa.frames > 0 && pa.overlaps.length === 0 && pa.floatOffRoad === 0 && pa.slotBad.length === 0, { frames: pa.frames, maxFloats: pa.maxFloats, overlaps: pa.overlaps });
    if (s.mode === 'running') {
      await page.keyboard.press('p');
      await waitFor(page, (x) => x.mode === 'paused', 1500, 'layout pause');
      await sleep(150);
      const pf = await fontAudit(page);
      check('text', tag + ' pause: every visible text is at least 14 px', pf.n > 3 && pf.bad.length === 0, { nodes: pf.n, min: pf.min, bad: pf.bad });
      await page.screenshot({ path: path.join(SHOTS, pre + '-' + tag + '-pause.png') });
    } else check('text', tag + ' pause: run ended before the pause check', false, s.mode);
    await ctx.close();
  }
}

/* ---------- OVERLAP: the real screens (keys, taps, button, drawn matatu, popups) ---------- */
const ovlUi = (page) => page.evaluate(() => {
  const b = document.getElementById('btnOverlap'), f = document.getElementById('ovlFill').style.transform;
  return { label: document.getElementById('ovlLbl').textContent, aria: b.getAttribute('aria-label'), ready: b.classList.contains('ready'), active: b.classList.contains('active'), fill: parseFloat((/scaleX\(([\d.]+)\)/.exec(f) || [0, NaN])[1]), live: document.getElementById('live').textContent };
});
/* Watches one overlap from "ready" to 1.3 s after it ends. fire() presses the key or taps the button. */
async function watchOverlap(page, fire, o) {
  o = o || {};
  const pa = mkPopupAudit();
  const out = { prior: o.prior || [], evs: [], samples: [], banner: false, floats: new Set(), readyUi: null, readyState: null, activeUi: [], afterUi: null, afterState: null, probe: null, shot: false };
  let since = o.since || 0, phase = 'wait', endT = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 100000) {
    const r = await read(page, since);
    const s = r.s;
    for (const x of r.e) { out.evs.push(x); since = x.i; }
    popupAudit(s, pa);
    for (const f of (s.view.floats || [])) out.floats.add(f.text);
    if (s.view.banner && s.view.banner.text === 'OVERLAP!') out.banner = true;
    if (phase === 'wait') {
      if (s.mode !== 'running') break;
      if (s.overlap.ready) {
        out.readyState = s; out.readyUi = await ovlUi(page);
        await fire();
        phase = 'active';
      }
    } else if (phase === 'active') {
      if (s.overlap.active && s.overlap.time < 3.3 && s.overlap.time > 0.2) {
        out.samples.push({ player: s.view.player, road: s.view.road, w: s.view.w, h: s.view.h, side: s.overlap.side, time: s.overlap.time, px: s.player.x });
        if (out.activeUi.length < 40) out.activeUi.push(await ovlUi(page));
        if (o.probe && !out.probe) out.probe = await o.probe(s);
        if (o.shot && !out.shot) { out.shot = true; await page.screenshot({ path: o.shot }); }
      }
      const endEv = out.evs.find((e) => e.type === 'overlapEnd');
      if (endEv) { endT = endEv.t; phase = 'after'; out.afterState = s; out.afterUi = await ovlUi(page); }
    } else if (s.time >= endT + 1.3 || s.mode !== 'running') { out.final = s; break; }
    await sleep(25);
  }
  out.pa = pa;
  return out;
}
function overlapAssertions(tag, via, out, fireSource) {
  const G = 'overlap', C = { OVERLAP_TIME: 4.0 };
  const ov = out.evs.find((e) => e.type === 'overlap'), end = out.evs.find((e) => e.type === 'overlapEnd'), rdy = out.evs.concat(out.prior || []).find((e) => e.type === 'overlapReady');
  /* by event number, not time: the pickup that filled the meter can share a tick with the activation */
  const within = (e) => ov && end && e.i > ov.i && e.t <= end.t + 0.9;
  const sam = out.samples;
  const inside = (a, b) => a.x >= b.x && a.x + a.w <= b.x + b.w;
  const outsideRoad = sam.length >= 5 && sam.every((m) => !rectsOverlap(m.player, m.road) && (ov.side < 0 ? m.player.x + m.player.w <= m.road.x + 0.5 : m.player.x >= m.road.x + m.road.w - 0.5));
  const onScreen = sam.length >= 5 && sam.every((m) => m.player.x >= -0.5 && m.player.x + m.player.w <= m.w + 0.5 && m.player.y >= 0 && m.player.y + m.player.h <= m.h);
  check(G, tag + ': ' + via + ' fires OVERLAP when the meter is full: one overlap event (source ' + fireSource + ', uses 1, side chosen from the lane), meter back to 0', !!rdy && !!ov && ov.source === fireSource && ov.uses === 1 && (ov.side === -1 || ov.side === 1) && out.readyState.overlap.meter >= 1 && out.evs.filter((e) => e.type === 'overlap').length === 1, { ov, rdy: !!rdy });
  check(G, tag + ': the button shows charging, then ready (OVERLAP!, ready pulse), then active (PITA!, bar draining), then charging again, with matching aria-labels', !!out.readyUi && out.readyUi.label === 'OVERLAP!' && out.readyUi.aria === 'Overlap ready' && out.readyUi.ready && out.activeUi.length >= 3 && out.activeUi.every((u) => u.label === 'PITA!' && u.aria === 'Overlap active' && u.active && !u.ready) && out.activeUi[0].fill > out.activeUi[out.activeUi.length - 1].fill && !!out.afterUi && out.afterUi.label === 'OVERLAP' && out.afterUi.aria === 'Overlap charging' && !out.afterUi.ready && !out.afterUi.active, { ready: out.readyUi, first: out.activeUi[0], last: out.activeUi[out.activeUi.length - 1], after: out.afterUi });
  check(G, tag + ': while active the matatu is drawn outside the road rect, on the ' + (ov && ov.side < 0 ? 'left' : 'right') + ' shoulder, fully on screen', outsideRoad && onScreen, { n: sam.length, first: sam[0], side: ov && ov.side });
  const bad = out.evs.filter((e) => within(e) && /^(hit|smash|nearMiss|pickup|repair|gameover)$/.test(e.type) && (e.type === 'hit' || e.type === 'gameover' || e.i < end.i));
  check(G, tag + ': from OVERLAP to the merge: no smash, near-miss, pickup or repair; no hit or game over until 0.9 s after the merge; merge lands in the edge lane on that side', !!end && bad.length === 0 && end.lane === (ov.side < 0 ? 0 : 3) && end.side === ov.side && out.afterState.player.invuln > 0.25, { bad: bad.slice(0, 3), end, invuln: out.afterState && out.afterState.player.invuln });
  check(G, tag + ': the activation banner (OVERLAP!) and the ready popup appeared; popups: none overlap, all stay within the road width, slot clear of road and matatu', out.banner && out.floats.has('OVERLAP READY!') && out.pa.frames > 0 && out.pa.overlaps.length === 0 && out.pa.floatOffRoad === 0 && out.pa.slotBad.length === 0, { banner: out.banner, floats: Array.from(out.floats).slice(0, 8), pa: { frames: out.pa.frames, overlaps: out.pa.overlaps.length, off: out.pa.floatOffRoad, slotBad: out.pa.slotBad.length } });
}
async function ovlControlsFit(page, tag) {
  const r = await page.evaluate(() => {
    const ids = ['btnLeft', 'btnHorn', 'btnOverlap', 'btnRight'];
    const box = ids.map((id) => { const q = document.getElementById(id).getBoundingClientRect(); return { id, x: q.left, y: q.top, w: q.width, h: q.height }; });
    const o = document.getElementById('btnOverlap'), l = document.getElementById('ovlLbl');
    return { box, vw: innerWidth, vh: innerHeight, clipped: o.scrollWidth > o.clientWidth + 1 || l.scrollWidth > l.clientWidth + 1, font: parseFloat(getComputedStyle(l).fontSize) };
  });
  const allIn = r.box.every((b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= r.vw && b.y + b.h <= r.vh && b.w >= 44 && b.h >= 44);
  let apart = true;
  for (let i = 0; i < r.box.length; i++) for (let j = i + 1; j < r.box.length; j++) if (rectsOverlap(r.box[i], r.box[j])) apart = false;
  check('overlap', tag + ': the four controls (left, horn, overlap, right) are on screen, at least 44 px, side by side without overlap; the OVERLAP label is not clipped and is 14 px or more', allIn && apart && !r.clipped && r.font >= 14, { box: r.box.map((b) => b.id + ':' + Math.round(b.w) + 'x' + Math.round(b.h)), clipped: r.clipped, font: r.font });
}

async function overlapBrowserChecks(browser) {
  const G = 'overlap';
  const cfg = [
    /* [w, h, touch, how it is fired, source] */
    [844, 390, true, 'key S', 'keyboard'],
    [320, 568, true, 'key ArrowDown', 'keyboard'],
    [390, 844, true, 'a tap on #btnOverlap', 'touch']
  ];
  /* ---- A. real human run on desktop: pick up passengers with the test bot, press the Shift key ---- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage(); watch(page, 'overlap-desktop');
    await page.goto(URL + '?seed=7');
    await page.waitForFunction(() => !!window.MatatuRush);
    await fontsReady(page); await sleep(300);
    const text = await page.evaluate(() => ({ title: document.getElementById('title').innerText, keys: document.querySelector('#title .keys').innerText }));
    check(G, 'title controls text explains overlap (Shift) next to horn nitro', /overlap/i.test(text.keys) && /\bShift\b/.test(text.keys) && /horn nitro/i.test(text.title), text.keys);
    await page.click('#btnHow');
    const how = await page.evaluate(() => ({ rules: document.querySelector('#howto .rules').innerText, keys: document.querySelector('#howto .keys').innerText }));
    check(G, 'How to play: one line "fill it with passengers, then ride the shoulder past everything" and the key in the keys block', /Overlap/.test(how.rules) && /fill it with passengers, then ride the shoulder past everything/i.test(how.rules) && /overlap/i.test(how.keys), how);
    await page.keyboard.press('Escape');
    await page.click('#btnStart');
    let s = await waitFor(page, (x) => x.mode === 'running', 3000, 'overlap desktop run');
    await ovlControlsFit(page, '1280x720');
    await sleep(150); /* let the HUD paint its first frame */
    const ui0 = await ovlUi(page);
    check(G, '1280x720: before any pickup the meter is empty and the button reads OVERLAP with the aria-label "Overlap charging"', s.overlap.meter === 0 && ui0.label === 'OVERLAP' && ui0.aria === 'Overlap charging' && !ui0.ready && !ui0.active && ui0.fill === 0, { overlap: s.overlap, ui0 });
    /* not ready: Shift, O, S and ArrowDown all reach the game and answer overlapEmpty (nothing else happens) */
    const e0 = (await read(page, 0)).e.length;
    for (const k of ['Shift', 'o', 'S', 'ArrowDown']) { await page.keyboard.press(k); await sleep(60); }
    let r = await read(page, e0);
    const emp = r.e.filter((x) => x.type === 'overlapEmpty');
    check(G, '1280x720: Shift, O, S and ArrowDown while charging each give overlapEmpty (source keyboard) and start nothing', emp.length === 4 && emp.every((x) => x.source === 'keyboard' && x.reason === 'charging') && !r.s.overlap.active && r.e.filter((x) => x.type === 'overlap').length === 0, emp.map((x) => x.reason));
    /* typing in a text box never fires it */
    await page.evaluate(() => { const i = document.createElement('input'); i.id = 'tmpType'; i.type = 'text'; document.body.appendChild(i); i.focus(); });
    const e1 = (await read(page, 0)).e.filter((x) => x.type === 'overlapEmpty').length, kb1 = (await snap(page)).inputs.keyboard;
    for (const k of ['Shift', 'o', 'O', 's', 'ArrowDown']) { await page.keyboard.press(k); await sleep(40); }
    const e2 = (await read(page, 0)).e.filter((x) => x.type === 'overlapEmpty').length, kb2 = (await snap(page)).inputs.keyboard;
    await page.evaluate(() => { document.getElementById('tmpType').remove(); });
    check(G, '1280x720: typing O, S or ArrowDown inside a text box fires nothing (no overlapEmpty, keyboard input count unchanged)', e1 === e2 && kb1 === kb2, { e1, e2, kb1, kb2 });
    /* pick up passengers with real keys until the meter is full */
    let readyRun = null, attempts = 0, since = 0;
    while (!readyRun && attempts < 4) {
      attempts++;
      const run = await drive(page, { ms: 80000, mode: 'seek', want: new Set(['stage']), steer: keySteer(page), since, onTick: (q) => (q.overlap.ready ? 'stop' : undefined) });
      since = run.since;
      if (run.s.overlap.ready) readyRun = run; else { await sleep(800); await skipNameIfShown(page); await page.keyboard.press('Enter'); await waitFor(page, (x) => x.mode === 'running', 3000, 'overlap retry'); since = 0; }
    }
    check(G, '1280x720: a real run fills the meter ONLY through pickups: ready after at least 8 pickups, announced once (live region says "Overlap ready")', !!readyRun && readyRun.s.stats.pickups >= 8 && readyRun.evs.filter((x) => x.type === 'overlapReady').length === 1, { pickups: readyRun && readyRun.s.stats.pickups, attempts });
    if (readyRun) {
      const liveNow = (await ovlUi(page)).live;
      const out = await watchOverlap(page, () => page.keyboard.press('Shift'), {
        since, prior: readyRun.evs,
        shot: path.join(SHOTS, '60-overlap-1280x720.png'),
        probe: async (q) => {
          const hb = q.horn.meter, ln = q.player.lane;
          await page.keyboard.press('Space'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight'); await sleep(60);
          const rr = await read(page, 0), q2 = rr.s;
          const mine = rr.e.filter((x) => x.t >= q.time);
          return { hornEmpty: mine.filter((x) => x.type === 'hornEmpty' && x.reason === 'overlap').length, horn: mine.filter((x) => x.type === 'horn').length, lane: mine.filter((x) => x.type === 'lane' || x.type === 'bump').length, nitro: q2.horn.nitro, meterBefore: hb, meterAfter: q2.horn.meter, laneBefore: ln, laneAfter: q2.player.lane };
        }
      });
      overlapAssertions('1280x720', 'the Shift key', out, 'keyboard');
      const pr = out.probe || {};
      check(G, '1280x720: pressing Space (horn) and the lane keys while overlapping is refused: hornEmpty (reason overlap), no horn event, no nitro, horn meter not spent, no lane change', !!out.probe && pr.hornEmpty >= 1 && pr.horn === 0 && pr.lane === 0 && !pr.nitro && pr.meterAfter >= pr.meterBefore - 0.001 && pr.laneAfter === pr.laneBefore, pr);
      const fin = out.final || (await snap(page));
      check(G, '1280x720: sound: one overlap sfx and the ready chime were scheduled; the horn nitro sfx was never used for it', fin.audio.fired.overlap === 1 && fin.audio.fired.overlapReady >= 1 && (fin.audio.fired.horn || 0) === 0, fin.audio.fired);
      check(G, '1280x720: the live region announced "Overlap ready" when it filled (read right after the fill)', /Overlap ready/.test(liveNow), liveNow);
    }
    await ctx.close();
  }
  /* ---- B. small and touch viewports: demo (autopilot) collects the passengers, the test fires it ---- */
  for (const [w, h, touch, how, src] of cfg) {
    const tag = w + 'x' + h;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 2 : 1 });
    const page = await ctx.newPage(); watch(page, 'overlap-' + tag);
    await page.goto(URL + '?seed=7&autostart=1&autopilot=1');
    await page.waitForFunction(() => !!window.MatatuRush);
    await fontsReady(page);
    await waitFor(page, (x) => x.mode === 'running', 3000, 'overlap demo ' + tag);
    await sleep(300);
    await ovlControlsFit(page, tag);
    const tapBtn = async () => { const b = await page.locator('#btnOverlap').boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); };
    const fire = how.indexOf('tap') >= 0 ? tapBtn : (how === 'key S' ? () => page.keyboard.press('S') : () => page.keyboard.press('ArrowDown'));
    /* one early press while charging */
    const sEarly = await snap(page);
    const e0 = (await read(page, 0)).e.length;
    if (sEarly.overlap.meter < 1) {
      await fire(); await sleep(80);
      const rr = await read(page, e0), ui = await ovlUi(page);
      check(G, tag + ': ' + how + ' while charging gives overlapEmpty (' + src + ') and the button stays "OVERLAP / Overlap charging"', rr.e.filter((x) => x.type === 'overlapEmpty' && x.source === src).length === 1 && !rr.s.overlap.active && ui.label === 'OVERLAP' && ui.aria === 'Overlap charging', { events: rr.e.map((x) => x.type + ':' + (x.source || '')).slice(-6), ui });
    }
    const out = await watchOverlap(page, fire, { since: 0, shot: (w === 320 || w === 844) ? path.join(SHOTS, '61-overlap-' + tag + '.png') : null });
    overlapAssertions(tag, how, out, src);
    await ctx.close();
  }
  /* ---- C. 280 px wide: the longest label (the ready one, OVERLAP!) must sit inside the button ---- */
  {
    const ctx = await browser.newContext({ viewport: { width: 280, height: 653 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage(); watch(page, 'overlap-280x653');
    await page.goto(URL + '?seed=7&autostart=1&autopilot=1');
    await page.waitForFunction(() => !!window.MatatuRush);
    await fontsReady(page);
    await waitFor(page, (x) => x.mode === 'running', 3000, 'overlap demo 280x653');
    const r = await page.evaluate(() => {
      const o = document.getElementById('btnOverlap'), l = document.getElementById('ovlLbl');
      l.textContent = 'OVERLAP!'; /* measured in the same turn, before the game rewrites it */
      const b = o.getBoundingClientRect(), t = l.getBoundingClientRect(), cs = getComputedStyle(l);
      const bw = o.clientLeft;
      return { btn: [b.left, b.right], label: [t.left, t.right], border: bw, font: parseFloat(cs.fontSize), vw: innerWidth };
    });
    check(G, '280x653: the ready label (OVERLAP!) is not clipped by the overlap button and is 14 px or more', r.vw === 280 && r.label[0] >= r.btn[0] + r.border - 0.01 && r.label[1] <= r.btn[1] - r.border + 0.01 && r.font >= 14, r);
    await ctx.close();
  }
}

/* Recorder for the audio-on capture. Installed by the test before the page loads; it only taps the
   Web Audio graph (whatever is connected to the destination is also fed to a MediaRecorder). It
   never touches game state, and nothing is recorded until the game itself creates its context,
   which only happens after a real click. */
const AUDIO_TAP = () => {
  const rec = window.__rec = { chunks: [], startedAt: 0, mr: null, error: null };
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest) {
    const r = orig.apply(this, arguments);
    try {
      if (dest === this.context.destination && !rec.mr) {
        const msd = this.context.createMediaStreamDestination();
        orig.call(this, msd);
        const mr = rec.mr = new MediaRecorder(msd.stream, { mimeType: 'audio/webm;codecs=opus' });
        mr.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
        mr.onstart = () => { rec.startedAt = Date.now() / 1000; };
        mr.start(250);
      }
    } catch (e) { rec.error = String(e && e.message || e); }
    return r;
  };
  rec.stop = () => new Promise((res) => {
    if (!rec.mr) return res({ b64: null, error: rec.error || 'no recorder' });
    rec.mr.onstop = () => {
      const fr = new FileReader();
      fr.onload = () => res({ b64: String(fr.result).split(',')[1], startedAt: rec.startedAt, error: rec.error });
      fr.readAsDataURL(new Blob(rec.chunks, { type: 'audio/webm' }));
    };
    rec.mr.stop();
  });
};

/* Near-miss: steer at a hazard with real keys and swerve out at the last moment. Repair: take a
   hit, then drive into the fundi spanner. Both asserted from the event log only. */
async function nearMissAndRepair(browser, seed) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage(); watch(page, 'nearmiss-repair');
  await page.goto(URL + '?seed=' + seed);
  await page.waitForFunction(() => !!window.MatatuRush);
  const out = { near: null, nearHit: false, repair: null, before: null, after: null, bannerBad: 0, bannerSeen: 0, runs: 0, hits: 0 };
  let since = 0;
  const t0 = Date.now();
  for (let r = 0; r < 6 && Date.now() - t0 < 110000 && !(out.near && out.repair); r++) {
    out.runs++;
    if (r === 0) await page.keyboard.press('Enter'); else { await sleep(750); await page.keyboard.press('Enter'); }
    await waitFor(page, (x) => x.mode === 'running', 3000, 'nm run ' + r);
    let prev = null, dodged = new Set();
    while (Date.now() - t0 < 110000) {
      const rd = await read(page, since), s = rd.s;
      for (const x of rd.e) {
        since = x.i;
        if (x.type === 'hit') out.hits++;
        if (x.type === 'nearMiss' && !out.near) { out.near = x; out.nearHit = rd.e.some((y) => y.type === 'hit' && y.id === x.id); out.nearScore = { before: prev ? prev.score : null, after: s.score, stat: s.stats.nearMiss }; }
        if (x.type === 'repair' && !out.repair) { out.repair = x; out.before = prev ? { health: prev.health, score: prev.score, px: prev.player.x } : null; out.after = { health: s.health, score: s.score, repairs: s.stats.repairs }; }
      }
      if (s.view.banner) {
        out.bannerSeen++;
        const v = s.view;
        if (rectsOverlap(v.banner, { x: v.roadX, y: v.hudBottom + 0.6 * v.unit, w: v.roadW, h: v.h })) out.bannerBad++;
      }
      if (s.mode !== 'running' || (out.near && out.repair)) break;
      prev = s;
      const cur = s.player.lane;
      let dir = 0;
      const fix = s.entities.find((e) => e.type === 'repair' && !e.taken && e.d > 0.2 && e.d < 9);
      if (out.near && s.health === 3 && !out.repair) {
        dir = decide(s, 'seek', new Set(['pothole'])); /* need damage before a fundi can appear */
      } else if (fix && s.health < 3) {
        dir = fix.lane === cur ? decide(s, 'play', new Set()) * 0 : (fix.lane > cur ? 1 : -1);
      } else if (!out.near && s.player.invuln <= 0 && !s.horn.nitro) {
        /* late swerve: sit in a pothole's lane, leave when contact is about 0.12 s away */
        const tgt = s.entities.filter((e) => e.type === 'pothole' && live(e) && e.d > 0.9 && e.d < 9 && !dodged.has(e.id)).sort((a, b) => a.d - b.d)[0];
        if (tgt) {
          const tc = (tgt.d - 1.05) / Math.max(0.5, s.speed);
          if (tgt.lane !== cur && tc > 0.45) dir = tgt.lane > cur ? 1 : -1;
          else if (tgt.lane === cur && tc < 0.13) { dir = cur === 0 ? 1 : (cur === 3 ? -1 : (s.entities.some((e) => live(e) && LEN[e.type] !== undefined && covers(e, cur + 1) && Math.abs(e.d) < 2.5) ? -1 : 1)); dodged.add(tgt.id); }
          else if (tgt.lane !== cur) dir = decide(s, 'play', new Set());
        } else dir = decide(s, 'play', new Set());
      } else dir = decide(s, 'play', new Set());
      if (dir) await page.keyboard.press(dir < 0 ? 'ArrowLeft' : 'ArrowRight');
      await sleep(14);
    }
  }
  await ctx.close();
  return out;
}

/* ===== online (shared board) group ===== */
const http = require('http');
const NodeURL = require('url').URL; /* the global URL is shadowed by the game URL constant at the top of this file */
const ONLINE_RULES = path.join(ROOT, 'firestore.rules');

/* Node checks: the same js/online.js in a bare context. The XHR constructor counts every use. */
function onlineHarness(opt) {
  opt = opt || {};
  const store = Object.assign({}, opt.store || {});
  const calls = { xhr: 0 };
  const win = {
    location: { protocol: opt.protocol === undefined ? 'http:' : opt.protocol, search: '' },
    localStorage: { getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }, setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    XMLHttpRequest: function () { calls.xhr++; throw new Error('XHR must not be used here'); },
    setTimeout, clearTimeout
  };
  if (opt.cfg !== null) win.MR_ONLINE_TEST = opt.cfg || { projectId: 'p', apiKey: 'k' };
  win.window = win;
  const ctx = vm.createContext(win);
  for (const f of ['js/core.js', 'js/online.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx);
  return { MR: win.MR, store, calls };
}
function onlineNodeChecks() {
  const G = 'online';
  const rules = fs.readFileSync(ONLINE_RULES, 'utf8');
  const alt = (/\(\^\|\.\*\[\^a-z\]\)\(([a-z|]+)\)\(s\|es\|er\|ing\)\?\(\[\^a-z\]\.\*\|\$\)/.exec(rules) || [null, ''])[1].split('|');
  const altSfx = (/\)\(([a-z|]+)\)\?\(\[\^a-z\]\.\*\|\$\)/.exec(rules) || [null, ''])[1].split('|');
  const h = onlineHarness();
  const list = Array.from(h.MR.online.BLOCKLIST);
  check(G, 'node: the blocklist in js/online.js is identical (same words, same order) to the one in firestore.rules', alt.length >= 25 && alt.length <= 40 && JSON.stringify(list) === JSON.stringify(alt), { client: list.length, rules: alt.length, onlyClient: list.filter((x) => alt.indexOf(x) < 0), onlyRules: alt.filter((x) => list.indexOf(x) < 0) });
  check(G, 'node: the suffix list (s, es, er, ing) in js/online.js is identical to the one in firestore.rules, and the rules match whole tokens: (^|.*[^a-z])(words)(suffixes)?([^a-z].*|$)',
    JSON.stringify(Array.from(h.MR.online.SUFFIXES)) === JSON.stringify(altSfx) && altSfx.join(',') === 's,es,er,ing', { client: h.MR.online.SUFFIXES, rules: altSfx });
  const cap = parseInt((/s <= (\d+)/.exec(rules) || [0, '0'])[1], 10);
  check(G, 'node: SCORE_MAX in js/online.js equals the cap in firestore.rules (5,000,000)', cap === 5000000 && h.MR.online.SCORE_MAX === cap, { rules: cap, client: h.MR.online.SCORE_MAX });
  const nre = (/matches\('(\^\[A-Za-z0-9\]\[A-Za-z0-9 \._-\]\{0,11\}\$)'\)/.exec(rules) || [])[1];
  check(G, 'node: the name pattern in firestore.rules is the one the client uses (1 to 12 chars, ASCII letters, digits, space . _ -)', nre === '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,11}$', nre);
  const ok = h.MR.online.nameOk;
  check(G, 'node: client name test: aliases and plain names pass; empty, 13 chars, leading space or hyphen, accents, HTML, quotes and blocklisted words (any case, embedded) fail',
    ['Dere 482', 'Konda 100', 'Makanga 999', 'Rubani 123', 'Bob', 'a_b-c.d e', '123456789012', 'Class Act'].every(ok) &&
    ['', '1234567890123', ' Bob', '-Bob', 'Wanjirú', '<b>x</b>', "O'Brien", 'Bob\n', 'FUCK', 'big fuck', 'MaLaYa', 'aa.KUMA.zz', 'Hitler'].every((x) => !ok(x)));
  const realNames = ['Kumar', 'Kumari', 'Shitote', 'Shitanda', 'Himalaya', 'Mbooni', 'Kunyanga', 'Malayan', 'Scunthorpe', 'Pissarides'];
  check(G, 'node: whole-token blocklist: Kumar, Kumari, Shitote, Shitanda, Himalaya, Mbooni, Kunyanga, Malayan, Scunthorpe and Pissarides are ALLOWED', realNames.every(ok), realNames.filter((x) => !ok(x)));
  const wl = Array.from(h.MR.online.BLOCKLIST);
  const missed = [];
  wl.forEach((w) => {
    const forms = [w, w.toUpperCase(), '6' + w + '9', 'a ' + w, w + '.x', 'x_' + w, w + 's', w + 'es', w + 'er', w + 'ing', '1-' + w];
    forms.forEach((f) => { if (f.length <= 12 && ok(f)) missed.push(f); });
  });
  check(G, 'node: every blocklist word is DENIED alone, in upper case, with digits around it (6word9), as a separate token (a word, word.x, x_word, 1-word) and with s, es, er, ing', wl.length >= 25 && missed.length === 0, missed);
  /* the gate: enabled() needs both config values AND an http(s) page */
  const gate = (proto, cfg) => onlineHarness({ protocol: proto, cfg }).MR.online.enabled();
  check(G, 'node: enabled() is false under file:// even with a full config, false with an empty config, true only for http: or https: with projectId and apiKey',
    gate('file:') === false && gate('http:', null) === false && gate('https:', null) === false && gate('http:', { projectId: 'p', apiKey: '' }) === false && gate('http:', { projectId: '', apiKey: 'k' }) === false &&
    gate('ftp:') === false && gate('about:') === false && gate('http:') === true && gate('https:') === true);
  /* under file:// nothing may reach XHR, whatever is called */
  const f = onlineHarness({ protocol: 'file:' });
  const o = f.MR.online;
  let cbs = 0;
  const q = o.queue({ name: 'A', alias: 'Dere 111', score: 500 });
  o.top(() => { cbs++; }); o.flush(() => { cbs++; }); o.submit('A', 5, () => { cbs++; }, 'Dere 111');
  check(G, 'node: under file:// top, flush, submit and queue make zero XHR calls and store nothing', f.calls.xhr === 0 && q === false && cbs === 3 && Object.keys(f.store).length === 0, { xhr: f.calls.xhr, q, keys: Object.keys(f.store) });
  /* queue rules (enabled, but no request is ever sent here: flush is not called) */
  const q1 = onlineHarness();
  const qo = q1.MR.online, P = () => JSON.parse(q1.store['matatuRush.pending'] || 'null');
  const r1 = qo.queue({ name: 'Dere 111', alias: 'Dere 111', score: 500 });
  const r2 = qo.queue({ name: 'Konda 222', alias: 'Konda 222', score: 400 });
  const afterLower = JSON.stringify(P());
  const r3 = qo.queue({ name: 'Rubani 333', alias: 'Rubani 333', score: 900 });
  const r4 = qo.queue({ name: 'Makanga 444', alias: 'Makanga 444', score: 900 });
  check(G, 'node: queue keeps ONE pending record and the higher score (a lower or equal one is ignored, a higher one replaces it)',
    r1 === true && r2 === false && afterLower === JSON.stringify({ name: 'Dere 111', alias: 'Dere 111', score: 500 }) && r3 === true && r4 === false && P().score === 900 && P().name === 'Rubani 333', P());
  check(G, 'node: rename updates the pending name only (empty or missing record: no change)', qo.rename('Mama Pima') === true && P().name === 'Mama Pima' && P().alias === 'Rubani 333' && qo.rename('   ') === false && P().name === 'Mama Pima');
  const q2 = onlineHarness({ store: { 'matatuRush.onlineBest': '700' } }).MR.online;
  check(G, 'node: only a score above onlineBest is queued; 0, negative, NaN, text and above-cap scores never are', q2.queue({ name: 'A', alias: 'Dere 111', score: 700 }) === false && q2.queue({ name: 'A', alias: 'Dere 111', score: 701 }) === true &&
    [0, -3, NaN, 'abc', null, 5000001].every((sc) => onlineHarness().MR.online.queue({ name: 'A', alias: 'Dere 111', score: sc }) === false));
  const bad = onlineHarness({ store: { 'matatuRush.pending': '{not json', 'matatuRush.auth': '[1,2]', 'matatuRush.onlineBest': 'zzz' } }).MR.online;
  check(G, 'node: corrupt stored pending, auth and onlineBest read as empty and do not throw', bad.pending() === null && bad.uid() === '' && bad.best() === 0);
}


/* A fake world for the pending-record logic: one shared clock, one fake Firestore (10 s rule modelled), shared storage,
   and fake timers that only move when the test says so. Nothing here touches a real clock or the network. */
function simWorld() {
  const w = { clock: { t: 1700000000000 }, store: {}, server: { score: 0, name: '', ts: 0, always403: false, status: 0, tokenStatus: 200, getStatus: 0 }, skew: 0, signups: 0, timers: [], nextId: 0, hold: false, held: [] };
  w.advance = (ms) => {
    const target = w.clock.t + ms;
    for (;;) {
      const due = w.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      w.timers.splice(w.timers.indexOf(due), 1);
      if (due.at > w.clock.t) w.clock.t = due.at;
      due.fn();
    }
    w.clock.t = target;
  };
  w.release = () => { const h = w.held.splice(0); h.forEach((f) => f()); };
  return w;
}
function simTab(w, opt) {
  opt = opt || {};
  const tab = { commits: [], gets: 0, reqs: [] };
  function XHR() { this.status = 0; this.responseText = ''; this.h = {}; }
  XHR.prototype.open = function (m, u) { this.m = m; this.u = u; };
  XHR.prototype.setRequestHeader = function (k, v) { this.h[k] = v; };
  const reply = (x, status, obj) => { x.status = status; x.responseText = JSON.stringify(obj || {}); x.onload(); };
  XHR.prototype.send = function (body) {
    const x = this; tab.reqs.push({ m: x.m, u: x.u });
    if (/accounts:signUp/.test(x.u)) { w.signups++; reply(x, 200, { idToken: 'i', refreshToken: 'r', localId: 'sim' + w.signups, expiresIn: '3600' }); return; }
    if (/\/v1\/token/.test(x.u)) {
      if (w.server.tokenStatus !== 200) { reply(x, w.server.tokenStatus, { error: { message: 'INVALID_REFRESH_TOKEN' } }); return; }
      reply(x, 200, { id_token: 'i2', expires_in: '3600', refresh_token: 'r' }); return;
    }
    if (x.m === 'GET' && /\/documents\/scores\/sim[0-9]+/.test(x.u)) {
      tab.gets++;
      const sv = w.server;
      if (sv.getStatus === 'net') { x.onerror(); return; }
      if (sv.getStatus) { reply(x, sv.getStatus, {}); return; }
      if (!sv.score) reply(x, 404, {});
      else reply(x, 200, { fields: { name: { stringValue: sv.name }, score: { integerValue: String(sv.score) }, ts: { timestampValue: new Date(sv.ts).toISOString() } } });
      return;
    }
    if (/:commit/.test(x.u)) {
      const wr = JSON.parse(body).writes[0];
      const rec = { name: wr.update.fields.name.stringValue, score: parseInt(wr.update.fields.score.integerValue, 10), sentAt: w.clock.t, doc: wr.update.name };
      tab.commits.push(rec);
      const decide = () => { /* the server decides when the request ARRIVES */
        const sv = w.server;
        if (sv.status) { reply(x, sv.status, {}); return; }
        if (sv.always403 || rec.score < sv.score || w.clock.t - sv.ts <= 10000) { reply(x, 403, {}); return; }
        sv.score = rec.score; sv.name = rec.name; sv.ts = w.clock.t;
        reply(x, 200, {});
      };
      if (w.hold) w.held.push(decide); else decide();
      return;
    }
    reply(x, 404, {});
  };
  const store = opt.store || w.store; /* a tab that does not share storage gets its own */
  tab.store = store;
  const win = {
    location: { protocol: 'http:', search: '' },
    localStorage: { getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }, setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    XMLHttpRequest: XHR,
    setTimeout: (fn, ms) => { const id = ++w.nextId; w.timers.push({ id, at: w.clock.t + ms, fn }); return id; },
    clearTimeout: (id) => { w.timers = w.timers.filter((x) => x.id !== id); },
    MR_ONLINE_TEST: { projectId: 'p', apiKey: 'k', now: () => w.clock.t + w.skew }
  };
  win.window = win;
  if (!store['matatuRush.auth'] && !opt.noAuth) store['matatuRush.auth'] = JSON.stringify({ uid: 'sim1', refreshToken: 'r' });
  const ctx = vm.createContext(win);
  for (const f of ['js/core.js', 'js/online.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx);
  tab.o = win.MR.online;
  tab.pend = () => { try { return JSON.parse(store['matatuRush.pending'] || 'null'); } catch (e) { return null; } };
  tab.flush = () => { const r = []; tab.o.flush((e, v) => r.push([e, v])); return r; };
  return tab;
}
function onlineSimChecks() {
  const G = 'online';
  const rec = (name, score) => ({ name, alias: name, score });
  /* 1. the reviewer's repro on shared storage: tab A sent 500; tab B queues 900 and flushes at once. B waits (shared send time), then wins. */
  {
    const w = simWorld(), a = simTab(w), b = simTab(w);
    a.o.queue(rec('Tab A', 500)); a.flush();
    const q = b.o.queue(rec('Tab B', 900));
    b.flush();
    const early = b.commits.length;
    w.advance(5000); const mid = b.commits.length;
    w.advance(6200);
    check(G, 'sim: two tabs on shared storage: B (900) flushed right after A (500) sent waits for the window (nothing at 0 s or 5 s), then sends exactly once; the server holds 900, B\'s pending record is gone, nothing is lost',
      q === true && early === 0 && mid === 0 && b.commits.length === 1 && w.server.score === 900 && b.pend() === null && b.o.best() === 900, { q, early, mid, n: b.commits.length, server: w.server, pend: b.pend() });
  }
  /* 2. a tab that does not know about the other send (no stored send time) gets 403: keeps the record, retries later after re-reading the server copy */
  {
    const w = simWorld(), a = simTab(w);
    a.o.queue(rec('Tab A', 500)); a.flush();
    w.advance(3000);
    const b = simTab(w, { store: { 'matatuRush.auth': JSON.stringify({ uid: 'sim1', refreshToken: 'r' }) } });
    b.o.queue(rec('Tab B', 900));
    const r1 = b.flush();
    const kept = b.pend();
    check(G, 'sim: a "too soon" 403 KEEPS the pending record (900), counts attempts = 1 and does not touch onlineBest',
      r1.length === 1 && r1[0][0] === 'retry' && !!kept && kept.score === 900 && kept.attempts === 1 && b.commits.length === 1 && w.server.score === 500, { r1, kept, server: w.server });
    w.advance(6000);
    const quiet = b.commits.length;
    w.advance(5300); /* now more than 11 s after the 403 answer */
    check(G, 'sim: the retry waits 11 s after the answer (nothing at +6 s), then first re-reads the server copy (one GET) and sends once; the 900 lands and the record is cleared',
      quiet === 1 && b.gets === 1 && b.commits.length === 2 && w.server.score === 900 && b.pend() === null && b.o.best() === 900, { quiet, gets: b.gets, n: b.commits.length, server: w.server, pend: b.pend() });
  }
  /* 3. slow connection: the answer arrives 3 s after the request left; the next write must be 11 s after the ANSWER */
  {
    const w = simWorld(), a = simTab(w);
    w.hold = true;
    a.o.queue(rec('Slow', 500)); a.flush();
    w.advance(3000); w.release(); /* arrives and is answered now: server time = T+3 s */
    w.hold = false;
    a.o.queue(rec('Slow', 900));
    a.flush();
    const t0 = a.commits.length;
    w.advance(8100); /* 11.1 s after the first request LEFT, but only 8.1 s after the answer */
    const t1 = a.commits.length;
    w.advance(3000);
    check(G, 'sim: slow answer: a follow-up 11.1 s after the request left (8.1 s after the answer) is NOT sent; it goes out 11 s after the answer and the server accepts it (no 403)',
      t0 === 1 && t1 === 1 && a.commits.length === 2 && w.server.score === 900 && a.pend() === null, { t0, t1, n: a.commits.length, server: w.server });
  }
  /* 4. 403 forever: three attempts, 11 s apart, then dropped; never a tight loop */
  {
    const w = simWorld(), a = simTab(w);
    w.server.always403 = true;
    a.o.queue(rec('Nope', 700)); a.flush();
    const n1 = a.commits.length, p1 = a.pend();
    w.advance(10000); const n2 = a.commits.length;
    w.advance(1300); const n3 = a.commits.length, p3 = a.pend();
    w.advance(10000); const n4 = a.commits.length;
    w.advance(1400); const n5 = a.commits.length, p5 = a.pend();
    w.advance(60000);
    check(G, 'sim: a 403 that never goes away: attempts 1, 2, 3 are 11 s or more apart (nothing at +10 s), the record is dropped after the third, and nothing more is sent ever after',
      n1 === 1 && p1 && p1.attempts === 1 && n2 === 1 && n3 === 2 && p3 && p3.attempts === 2 && n4 === 2 && n5 === 3 && p5 === null && a.commits.length === 3 &&
      a.commits[1].sentAt - a.commits[0].sentAt >= 11000 && a.commits[2].sentAt - a.commits[1].sentAt >= 11000, { n: [n1, n2, n3, n4, n5], p1, p3, p5, at: a.commits.map((c) => c.sentAt - a.commits[0].sentAt) });
  }
  /* 5. 429 behaves like 403; 400 drops at once; 500 keeps without a retry loop */
  {
    const w = simWorld(), a = simTab(w);
    w.server.status = 429;
    a.o.queue(rec('Busy', 700)); a.flush();
    const k429 = a.pend();
    const w4 = simWorld(), b = simTab(w4);
    w4.server.status = 400;
    b.o.queue(rec('Bad', 700)); const r = b.flush();
    const w5 = simWorld(), c = simTab(w5);
    w5.server.status = 500;
    c.o.queue(rec('Down', 700)); c.flush(); w5.advance(120000);
    check(G, 'sim: 429 keeps the record with attempts 1; 400 drops it at once with no retry; a 500 keeps it with no retry loop',
      !!k429 && k429.attempts === 1 && r[0][0] === 'rejected' && b.pend() === null && w4.timers.length === 0 && c.pend() !== null && c.commits.length === 1, { k429, r, c: c.commits.length });
  }
  /* 6. the retry resync: the server already holds this score under this name, or a higher one: clear without sending */
  {
    const w = simWorld(), a = simTab(w);
    w.server.score = 900; w.server.name = 'Same'; w.server.ts = w.clock.t - 60000;
    w.store['matatuRush.pending'] = JSON.stringify({ name: 'Same', alias: 'Same', score: 900, attempts: 1 });
    a.flush();
    const w2 = simWorld(), b = simTab(w2);
    w2.server.score = 900; w2.server.name = 'Other'; w2.server.ts = w2.clock.t - 60000;
    w2.store['matatuRush.pending'] = JSON.stringify({ name: 'Same', alias: 'Same', score: 900, attempts: 1 });
    b.flush();
    check(G, 'sim: after a 403 the retry re-reads the server copy: same score and same name clears the record without sending (onlineBest resynced); same score but another name is a rename and is sent',
      a.gets === 1 && a.commits.length === 0 && a.pend() === null && a.o.best() === 900 && b.gets === 1 && b.commits.length === 1 && w2.server.name === 'Same' && b.pend() === null, { a: [a.gets, a.commits.length, a.pend()], b: [b.gets, b.commits.length, w2.server] });
  }
  /* 7. another tab changed the pending record while this one waited */
  {
    const w = simWorld(), a = simTab(w);
    a.o.queue(rec('First', 100)); a.flush();
    a.o.queue(rec('Second', 200)); a.flush(); /* waits for the window */
    w.store['matatuRush.pending'] = ''; /* another tab sent it and cleared it */
    w.advance(11200);
    const sent = a.commits.length;
    a.o.queue(rec('Third', 300)); const higher = a.o.queue(rec('Lower', 250));
    check(G, 'sim: a record cleared by another tab while this tab waited is not sent (the pending record is re-read after the wait); queue keeps the higher score',
      sent === 1 && higher === false && a.pend() && a.pend().score === 300, { sent, pend: a.pend() });
  }
  /* 8. pre-validation: nothing the rules would refuse is ever sent */
  {
    const w = simWorld(), a = simTab(w);
    w.store['matatuRush.onlineBest'] = '900';
    w.store['matatuRush.pending'] = JSON.stringify({ name: 'Old', alias: 'Old', score: 500 });
    const r1 = a.flush();
    const lowOk = a.commits.length === 0 && a.pend() === null;
    w.store['matatuRush.pending'] = JSON.stringify({ name: 'Fuck', alias: 'Dere 111', score: 1000 });
    a.flush();
    const aliasSent = a.commits.length === 1 && a.commits[0].name === 'Dere 111';
    w.advance(12000);
    w.store['matatuRush.pending'] = JSON.stringify({ name: 'Wanjirú', alias: 'Shit', score: 2000 });
    const r3 = a.flush();
    check(G, 'sim: before sending the client checks what the rules check: a score below onlineBest is dropped unsent, a blocklisted name falls back to the alias, a bad name with a bad alias is dropped unsent',
      lowOk && aliasSent && a.commits.length === 1 && a.pend() === null && r3[0][0] === 'badname', { lowOk, aliasSent, n: a.commits.length, r1, r3 });
  }
  /* 9. the test override is typed: a string now() or a negative delayMs is ignored */
  {
    const w = simWorld(), a = simTab(w);
    a.o.queue(rec('T', 100)); a.flush();
    const sent = parseInt(w.store['matatuRush.lastSend'], 10);
    check(G, 'sim: the send time is stored in shared storage (matatuRush.lastSend) from the injected clock, stamped at the request and again at the answer', sent === w.clock.t, { sent, now: w.clock.t });
  }
  const YEAR = 365 * 86400000;
  const devNow = (w) => w.clock.t + w.skew;
  /* 10. N1: the device clock was a year ahead for one send, then got corrected. The stored send time is in the future; it must be
     clamped and repaired: the next flush waits exactly ONE window, sends, and nothing is stuck afterwards. */
  {
    const w = simWorld(), a = simTab(w);
    w.skew = YEAR;
    a.o.queue(rec('Ahead', 100)); a.flush();
    const first = a.commits.length;
    w.advance(12000);
    w.skew = 0; /* clock corrected */
    const storedAhead = parseInt(w.store['matatuRush.lastSend'], 10) > devNow(w) + YEAR / 2; /* the stored time is now far in the future, as in the reviewer's repro */
    a.o.queue(rec('Ahead', 200)); const r2 = a.flush();
    const rep = parseInt(w.store['matatuRush.lastSend'], 10) <= devNow(w); /* repaired the moment it was read */
    w.advance(10900); const early = a.commits.length;
    w.advance(200); const sent = a.commits.length;
    const ok2 = w.server.score === 200 && a.pend() === null && w.timers.length === 0;
    a.o.queue(rec('Ahead', 300)); const r3 = a.flush(); /* a flush after that must not be stuck behind 'busy' */
    w.advance(11100);
    check(G, 'sim: clock a year ahead for a send, then corrected: the stored time is repaired, the next flush sends after exactly one window (nothing at 10.9 s, sent by 11.1 s), is not stuck busy, and the flush after it works too',
      first === 1 && storedAhead && r2.length === 1 && early === 1 && sent === 2 && rep && ok2 && r3.length === 1 && a.commits.length === 3 && w.server.score === 300 && parseInt(w.store['matatuRush.lastSend'], 10) <= devNow(w),
      { first, storedAhead, r2, rep, early, sent, ok2, r3, n: a.commits.length, server: w.server, timers: w.timers.length });
  }
  /* 11. the clock jumps backwards while a flush is waiting: the wait is not repeated; the request is sent after the one window */
  {
    const w = simWorld(), b = simTab(w);
    b.o.queue(rec('Jump', 100)); b.flush();
    b.o.queue(rec('Jump', 200)); b.flush(); /* waits one window (the send time was just stamped) */
    const j0 = b.commits.length;
    w.advance(3000);
    w.skew = -YEAR; /* clock set back a year in the middle of the wait */
    w.advance(8100);
    const j1 = b.commits.length;
    w.advance(500);
    check(G, 'sim: clock set back a year in the middle of a wait: the wait is NOT repeated, the request goes out when the one window is over (11.1 s after the flush started), the pending record is cleared and no timer is left running',
      j0 === 1 && j1 === 2 && w.server.score === 200 && b.pend() === null && w.timers.length === 0 && b.commits.length === 2,
      { j0, j1, server: w.server, pend: b.pend(), timers: w.timers.length });
  }
  /* 12. clock set in the past: stored send time is an old (past) time, so nothing to wait for; the next send is not delayed */
  {
    const w = simWorld(), a = simTab(w);
    w.skew = -YEAR;
    a.o.queue(rec('Past', 100)); a.flush();
    w.advance(12000);
    w.skew = 0;
    a.o.queue(rec('Past', 200)); const r = a.flush();
    check(G, 'sim: clock a year in the past for a send, then corrected: the stored time is a year old, so the next flush sends at once (no wait, no timer) and the server holds the new score',
      a.commits.length === 2 && w.server.score === 200 && a.pend() === null && w.timers.length === 0 && r.length === 1, { n: a.commits.length, server: w.server, pend: a.pend(), timers: w.timers.length });
  }
  /* 13. flush calls made during a wait neither extend it nor start a second send; the watchdog frees a flush that hangs */
  {
    const w = simWorld(), a = simTab(w);
    a.o.queue(rec('Wait', 100)); a.flush();
    a.o.queue(rec('Wait', 200));
    const first = a.flush(); /* waits a full window */
    const busy = [];
    for (let i = 0; i < 5; i++) { w.advance(2000); busy.push(a.flush()); }
    const midN = a.commits.length; /* 10 s into the wait */
    w.advance(1100); /* 11.1 s after the wait began */
    check(G, 'sim: five more flush calls during a wait all answer "busy", do not push the send later (it still goes out 11.05 s after the first call), and do not send twice',
      busy.every((r) => r.length === 1 && r[0][0] === 'busy') && midN === 1 && a.commits.length === 2 && w.server.score === 200 && a.pend() === null && w.timers.length === 0 && first.length === 1,
      { busy, midN, n: a.commits.length, server: w.server, timers: w.timers.length });
    /* watchdog: a request that is never answered (no timeout fires) blocks flush as 'busy' for 45 s, then a new flush may start */
    const w2 = simWorld(), b = simTab(w2);
    w2.hold = true;
    b.o.queue(rec('Hung', 100)); const h1 = b.flush();
    w2.advance(30000);
    const h2 = b.flush();
    const n30 = b.commits.length;
    w2.advance(16000); /* 46 s since the hung flush began */
    w2.hold = false;
    const h3 = b.flush();
    w2.release(); /* the old answer finally arrives: it must neither crash nor free/steal the new flush */
    b.o.queue(rec('Hung', 300));
    w2.advance(12000);
    const h4 = b.flush();
    w2.advance(100);
    check(G, 'sim: watchdog: a flush whose request never answers is "busy" at 30 s (no second send), a new flush may start after 45 s and sends, the late answer of the dead one does no harm, and flushing is never stuck',
      h2.length === 1 && h2[0][0] === 'busy' && n30 === 1 && b.commits.length === 3 && w2.server.score === 300 && b.pend() === null && h3.length === 1 && h3[0][0] === null && h1.length === 1 && h4.length === 1,
      { h1, h2, h3, h4, n30, n: b.commits.length, server: w2.server, pend: b.pend() });
  }
  /* 14. N2: a refresh call answered 400 or 403 falls back to ONE fresh anonymous sign-up (new uid) and still sends; 5xx does not */
  {
    const out = [];
    [400, 403].forEach((code) => {
      const w = simWorld(), a = simTab(w);
      w.signups = 1; /* so the new id is sim2, not the old sim1 */
      w.server.tokenStatus = code;
      a.o.queue(rec('Resign', 100)); const r = a.flush();
      const au = JSON.parse(a.store['matatuRush.auth'] || 'null');
      const tokenCalls = a.reqs.filter((q) => /\/v1\/token/.test(q.u)).length;
      out.push({ code, r, signups: w.signups, tokenCalls, uid: au && au.uid, commits: a.commits.length, doc: a.commits[0] && a.commits[0].doc, server: w.server.score });
    });
    const w5 = simWorld(), c = simTab(w5);
    w5.server.tokenStatus = 500;
    c.o.queue(rec('Resign', 100)); const r5 = c.flush();
    const ok = out.every((o) => o.r.length === 1 && o.r[0][0] === null && o.signups === 2 && o.tokenCalls === 1 && o.uid === 'sim2' && o.commits === 1 && /\/scores\/sim2$/.test(o.doc) && o.server === 100);
    check(G, 'sim: refresh answered 400 or 403: one fresh sign-up (exactly one /v1/token call and one signUp), the new id is stored and used in the commit, the record is sent; refresh answered 500: no sign-up, record kept',
      ok && r5.length === 1 && r5[0][0] === 'server' && w5.signups === 0 && c.pend() !== null && c.commits.length === 0, { out, r5, signups5: w5.signups });
    /* the new uid really is a new one when the old one is known */
    const w6 = simWorld(); w6.signups = 6;
    const d = simTab(w6); w6.server.tokenStatus = 403;
    d.o.queue(rec('Resign', 100)); d.flush();
    check(G, 'sim: after a refresh 403 the stored anonymous id is a NEW id (not the old one) and the commit is written under it', JSON.parse(d.store['matatuRush.auth']).uid === 'sim7' && /\/scores\/sim7$/.test(d.commits[0].doc) && d.o.uid() === 'sim7', { auth: d.store['matatuRush.auth'], doc: d.commits[0] && d.commits[0].doc });
  }
  /* 15. L-a: reading this device's own entry keeps failing before a retry: it counts as an attempt and the send goes ahead anyway */
  {
    const pend = (attempts) => JSON.stringify({ name: 'ReadFail', alias: 'ReadFail', score: 800, attempts });
    const res = [];
    [500, 403].forEach((st) => {
      const w = simWorld(), a = simTab(w);
      w.server.getStatus = st;
      w.store['matatuRush.pending'] = pend(1);
      const r = a.flush();
      res.push({ st, r, gets: a.gets, commits: a.commits.length, server: w.server.score, pend: a.pend() });
    });
    const w2 = simWorld(), b = simTab(w2); /* read fails AND the send is refused (403): attempts 1 -> 2 (read) -> 3 (send) = dropped, one send only */
    w2.server.getStatus = 500; w2.server.always403 = true;
    w2.store['matatuRush.pending'] = pend(1);
    const r2 = b.flush(); w2.advance(60000);
    const w3 = simWorld(), c = simTab(w3); /* attempts already 2: one more failed read reaches 3 and drops the record unsent */
    w3.server.getStatus = 500;
    w3.store['matatuRush.pending'] = pend(2);
    const r3 = c.flush(); w3.advance(60000);
    const w4 = simWorld(), d = simTab(w4); /* no answer at all: not counted, the send goes ahead and also gets no answer... here the server is fine */
    w4.server.getStatus = 'net';
    w4.store['matatuRush.pending'] = pend(1);
    const r4 = d.flush();
    check(G, 'sim: own-entry read fails (HTTP 500 or 403) with a record at attempts 1: the send still goes out in the same flush and is cleared when accepted (never stuck unsent)',
      res.every((x) => x.gets === 1 && x.commits === 1 && x.server === 800 && x.pend === null && x.r.length === 1 && x.r[0][0] === null), res);
    check(G, 'sim: a failed read counts as an attempt: read fail + refused send from attempts 1 reaches 3 and drops the record after ONE send; attempts 2 + failed read drops it unsent; a read with no answer is not counted and the send goes ahead',
      b.commits.length === 1 && b.pend() === null && r2.length === 1 && r2[0][0] === 'rejected' && c.commits.length === 0 && c.pend() === null && r3.length === 1 && r3[0][0] === 'rejected' &&
      d.commits.length === 1 && d.pend() === null && r4.length === 1 && r4[0][0] === null,
      { b: [b.commits.length, b.pend(), r2], c: [c.commits.length, c.pend(), r3], d: [d.commits.length, d.pend(), r4] });
  }
}

/* a tiny static server for the repo root */
function startStaticServer() {
  const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ttf': 'font/ttf', '.png': 'image/png', '.json': 'application/json' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const full = path.normalize(path.join(ROOT, p));
    if (full.indexOf(ROOT + path.sep) !== 0 || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(full).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

const ON_CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'POST, GET, OPTIONS' };
const ON_HOSTS = ['identitytoolkit.googleapis.com', 'securetoken.googleapis.com', 'firestore.googleapis.com'];
const ON_PROJECT = 'test-proj', ON_KEY = 'test-key';
function makeMock() {
  return { signups: 0, refreshes: 0, commits: [], queries: [], log: [], stray: [], db: {}, rawQuery: null, queryStatus: 200, queryDelay: 0, commitStatus: 200, failCommits: 0, gets: [], tokenDelay: 0, tokenStatus: 200, net: false, netHits: 0 };
}
function mockRows(db) {
  const rows = Object.keys(db).map((uid) => ({ uid, name: db[uid].name, score: db[uid].score })).sort((a, b) => b.score - a.score).slice(0, 5);
  if (!rows.length) return [{ readTime: '2026-01-01T00:00:00Z' }];
  return rows.map((r) => ({ document: { name: 'projects/' + ON_PROJECT + '/databases/(default)/documents/scores/' + r.uid, fields: { name: { stringValue: r.name }, score: { integerValue: String(r.score) }, ts: { timestampValue: '2026-01-01T00:00:00Z' } }, createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00Z' }, readTime: '2026-01-01T00:00:00Z' }));
}
async function installMock(ctx, st) {
  const json = (route, status, obj) => route.fulfill({ status, headers: Object.assign({ 'content-type': 'application/json' }, ON_CORS), body: JSON.stringify(obj) });
  /* anything that is not the local server falls here first (registered first = checked last) and is refused */
  await ctx.route((u) => /^https?:$/.test(u.protocol) && u.hostname !== '127.0.0.1', (route) => { st.stray.push(route.request().url()); route.abort('failed'); });
  const handler = async (route) => {
    const req = route.request(), u = new NodeURL(req.url());
    if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: ON_CORS }); return; }
    if (st.net) { st.netHits++; await route.abort('failed'); return; }
    const post = req.postData() || '';
    const rec = { t: Date.now(), host: u.hostname, path: u.pathname, search: u.search, method: req.method(), body: post, auth: req.headers().authorization || '' };
    st.log.push(rec);
    if (u.pathname.endsWith('/accounts:signUp')) {
      st.signups++;
      await json(route, 200, { kind: 'identitytoolkit#SignupNewUserResponse', idToken: 'id-' + st.signups, refreshToken: 'rt-' + st.signups, expiresIn: '3600', localId: 'mockuid' + st.signups });
    } else if (u.pathname === '/v1/token') {
      st.refreshes++;
      if (st.tokenDelay) await sleep(st.tokenDelay);
      if (st.tokenStatus !== 200) { await json(route, st.tokenStatus, { error: { code: st.tokenStatus, message: 'INVALID_REFRESH_TOKEN' } }); return; }
      await json(route, 200, { id_token: 'id-r' + st.refreshes, refresh_token: new URLSearchParams(post).get('refresh_token') || 'rt', expires_in: '3600', user_id: 'x' });
    } else if (u.pathname.endsWith(':runQuery')) {
      st.queries.push(rec);
      if (st.queryDelay) await sleep(st.queryDelay);
      if (st.queryStatus !== 200) { await json(route, st.queryStatus, { error: { message: 'boom' } }); return; }
      await json(route, 200, st.rawQuery || mockRows(st.db));
    } else if (u.pathname.endsWith(':commit')) {
      let b = null; try { b = JSON.parse(post); } catch (e) { /* kept as null */ }
      st.commits.push({ t: rec.t, body: b, auth: rec.auth, search: u.search, path: u.pathname, host: u.hostname });
      if (st.failCommits > 0) { st.failCommits--; await json(route, st.commitStatus === 200 ? 403 : st.commitStatus, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' } }); return; }
      if (st.commitStatus !== 200) { await json(route, st.commitStatus, { error: { code: st.commitStatus, status: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' } }); return; }
      try {
        const w = b.writes[0], uid = w.update.name.split('/').pop();
        st.db[uid] = { name: w.update.fields.name.stringValue, score: parseInt(w.update.fields.score.integerValue, 10) };
      } catch (e) { /* malformed: leave db alone */ }
      await json(route, 200, { writeResults: [{ updateTime: '2026-01-01T00:00:00Z', transformResults: [{ timestampValue: '2026-01-01T00:00:00Z' }] }], commitTime: '2026-01-01T00:00:00Z' });
    } else if (req.method() === 'GET' && /\/documents\/scores\/[^/]+$/.test(u.pathname)) {
      const uid = u.pathname.split('/').pop();
      st.gets.push({ t: rec.t, uid });
      const d = st.db[uid];
      if (!d) { await json(route, 404, { error: { code: 404, status: 'NOT_FOUND' } }); return; }
      await json(route, 200, { name: 'projects/' + ON_PROJECT + '/databases/(default)/documents/scores/' + uid, fields: { name: { stringValue: d.name }, score: { integerValue: String(d.score) }, ts: { timestampValue: '2026-01-01T00:00:00Z' } } });
    } else await json(route, 404, {});
  };
  for (const h of ON_HOSTS) await ctx.route('https://' + h + '/**', handler);
}
/* console errors from the mocked network failing on purpose are expected; everything else counts */
function watchOnline(page, label) {
  pagesWatched++;
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.consoleErrors.push({ page: label, text: m.text() });
    if (m.type() === 'warning') problems.consoleWarnings.push({ page: label, text: m.text() });
  });
  page.on('pageerror', (e) => problems.pageErrors.push({ page: label, text: String(e && e.message || e) }));
  page.on('request', () => { requestsSeen++; });
}
const XHR_LOGGER = () => {
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    let mode = 'boot';
    try { mode = window.MatatuRush.snapshot().mode; } catch (e) { /* page not ready */ }
    (window.__xhr = window.__xhr || []).push({ m: this.__m, u: this.__u, mode, t: Date.now() });
    return send.apply(this, arguments);
  };
};
async function onlinePage(browser, base, opt) {
  opt = opt || {};
  const ctx = await browser.newContext({ viewport: opt.viewport || { width: 1280, height: 720 } });
  const st = makeMock();
  await installMock(ctx, st);
  const cfg = opt.cfg === undefined ? { projectId: ON_PROJECT, apiKey: ON_KEY } : opt.cfg;
  await ctx.addInitScript((c) => { if (c) window.MR_ONLINE_TEST = c; }, cfg);
  /* optional test overrides: a shorter rate window, and a clock the test moves by hand (window.__clk) */
  if (opt.delayMs !== undefined) await ctx.addInitScript((d) => { if (window.MR_ONLINE_TEST) window.MR_ONLINE_TEST.delayMs = d; }, opt.delayMs);
  if (opt.clock) await ctx.addInitScript((t0) => { window.__clk = t0; if (window.MR_ONLINE_TEST) window.MR_ONLINE_TEST.now = function () { return window.__clk; }; }, opt.clock);
  await ctx.addInitScript(XHR_LOGGER);
  const page = await ctx.newPage();
  watchOnline(page, opt.label || 'online');
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  return { ctx, page, st, dialogs, base };
}
const xhrLog = (page) => page.evaluate(() => window.__xhr || []);
async function until(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) return false;
    await sleep(40);
  }
}
const lsGet = (page, k) => page.evaluate((key) => localStorage.getItem(key), k);
const lsJson = async (page, k) => { try { return JSON.parse(await lsGet(page, k)); } catch (e) { return null; } };
const ON_ALIAS = /^(Dere|Konda|Makanga|Rubani) [1-9]\d\d$/;
/* seed 20 with no input crashes after about 11 s (score a few hundred), which always makes an empty local board */
async function idleToOver(page, base) {
  await page.goto(base + '/index.html?seed=20');
  await page.waitForFunction(() => !!window.MatatuRush);
  await page.keyboard.press('Enter');
  await waitFor(page, (x) => x.mode === 'running', 4000, 'online run');
  await page.waitForSelector('#over:not([hidden])', { timeout: 70000 });
  await sleep(120);
  return snap(page);
}
const commitFields = (c) => { try { const w = c.body.writes[0]; return { doc: w.update.name, name: w.update.fields.name.stringValue, score: w.update.fields.score.integerValue, tr: w.updateTransforms, keys: Object.keys(w), fkeys: Object.keys(w.update.fields), nwrites: c.body.writes.length }; } catch (e) { return null; } };

async function onlineBrowserChecks(browser, desktop) {
  const G = 'online';
  const { srv, port } = await startStaticServer();
  const base = 'http://127.0.0.1:' + port;
  const allMocks = [];
  const mk = async (opt) => { const o = await onlinePage(browser, base, opt); allMocks.push(o.st); return o; };
  try {
    /* ---- under file:// the same page, fully configured, stays offline ---- */
    {
      const ctx = await browser.newContext(desktop);
      const st = makeMock(); /* no routes on purpose: the page must not even try; watch() fails the run on any non-file request */
      await ctx.addInitScript((c) => { window.MR_ONLINE_TEST = c; }, { projectId: ON_PROJECT, apiKey: ON_KEY });
      await ctx.addInitScript(XHR_LOGGER);
      const page = await ctx.newPage(); watch(page, 'online-file');
      await page.goto(URL + '?seed=7');
      await page.waitForFunction(() => !!window.MatatuRush);
      const gate = await page.evaluate(() => window.MR.online.enabled());
      await page.evaluate(() => localStorage.setItem('matatuRush.top5', JSON.stringify([{ name: 'Local One', score: 777, id: 'l1' }])));
      await page.reload();
      await page.waitForFunction(() => !!window.MatatuRush);
      await page.click('#btnBoard');
      await sleep(300);
      const ui = await page.evaluate(() => ({ head: document.getElementById('boardH').textContent, rows: Array.from(document.querySelectorAll('#boardList li')).map((l) => l.textContent), note: !document.getElementById('boardNote').hidden, priv: !document.getElementById('boardPrivacy').hidden, loading: !document.getElementById('boardLoading').hidden }));
      const xs = await xhrLog(page);
      check(G, 'file://: with a full config MR.online.enabled() is false, boot and opening Top 5 make no request at all, and the sheet is the plain local one (no note, no privacy line, no Loading)',
        gate === false && xs.length === 0 && st.log.length === 0 && st.stray.length === 0 && ui.head === 'TOP 5' && ui.rows.length === 1 && /Local One/.test(ui.rows[0]) && !ui.note && !ui.priv && !ui.loading, { gate, xhr: xs.length, mock: st.log.length, stray: st.stray, ui });
      await ctx.close();
    }

    /* ---- reading the board: request shape, parsing, text-only rendering, states ---- */
    {
      const { ctx, page, st, dialogs } = await mk({ label: 'online-read' });
      await page.goto(base + '/index.html?seed=7');
      await page.waitForFunction(() => !!window.MatatuRush);
      check(G, 'http: enabled() is true with a config; booting with nothing pending sends no request', (await page.evaluate(() => window.MR.online.enabled())) === true && (await xhrLog(page)).length === 0);
      const doc = (uid, fields) => ({ document: { name: 'projects/' + ON_PROJECT + '/databases/(default)/documents/scores/' + uid, fields }, readTime: 't' });
      const S = (v) => ({ stringValue: v }), I = (v) => ({ integerValue: String(v) });
      st.rawQuery = [
        doc('uidAAAA1', { name: S('Wanjiru K'), score: I(90000), ts: { timestampValue: 't' } }),
        doc('uidBBBB2', { name: S('<img onerror=alert(1)>'), score: I(80000) }),
        doc('uidCCCC3', { name: S('Mwangi Kamau Junior'), score: I(70000) }),
        doc('uidDDDD4', { name: S('Float Guy'), score: { doubleValue: 60000.5 } }),
        doc('uidEEEE5', { name: { integerValue: '5' }, score: I(50000) }),
        doc('uidFFFF6', { score: I(40000) }),
        doc('uidGGGG7', { name: S('Neg'), score: I(-5) }),
        doc('uidHHHH8', { name: S('Zero'), score: I(0) }),
        doc('uidIIII9', { name: S('Junk'), score: I('12abc') }),
        doc('uid bad!', { name: S('Bad Id'), score: I(30000) }),
        doc('uidJJJJ0', { name: S('   '), score: I(25000) }),
        { readTime: 't' }, null, 'str', 7, { document: null }, { document: { name: 'x', fields: 'nope' } },
        doc('uidKKKK1', { name: S('Last Good'), score: I(20000) })
      ];
      const r = await page.evaluate(() => new Promise((res) => window.MR.online.top((e, rows) => res({ e, rows }))));
      check(G, 'top() parses a realistic runQuery answer: keeps good rows, drops rows with a missing or non-string name, double or negative or zero or junk score, bad id, blank name, non-objects; names cut to 12',
        r.e === null && JSON.stringify(r.rows) === JSON.stringify([{ name: 'Wanjiru K', score: 90000, id: 'uidAAAA1' }, { name: '<img onerror', score: 80000, id: 'uidBBBB2' }, { name: 'Mwangi Kamau', score: 70000, id: 'uidCCCC3' }, { name: 'Last Good', score: 20000, id: 'uidKKKK1' }]), r);
      const q = st.queries[0], qb = q && (() => { try { return JSON.parse(q.body); } catch (e) { return null; } })();
      check(G, 'top() sends one POST to the firestore host :runQuery for scores, orderBy score DESCENDING, limit 5, with no Authorization header',
        !!q && q.host === 'firestore.googleapis.com' && q.method === 'POST' && q.path === '/v1/projects/' + ON_PROJECT + '/databases/(default)/documents:runQuery' && q.auth === '' && q.search === '?key=' + ON_KEY &&
        JSON.stringify(qb) === JSON.stringify({ structuredQuery: { from: [{ collectionId: 'scores' }], orderBy: [{ field: { fieldPath: 'score' }, direction: 'DESCENDING' }], limit: 5 } }), { q: q && { host: q.host, path: q.path, auth: q.auth, search: q.search }, qb });
      /* the sheet: Loading first, then the list; the hostile name is plain text */
      st.queryDelay = 900;
      await page.click('#btnBoard');
      await sleep(250);
      const L = await page.evaluate(() => ({ open: !document.getElementById('board').hidden, head: document.getElementById('boardH').textContent, loading: !document.getElementById('boardLoading').hidden, loadTxt: document.getElementById('boardLoading').textContent, listHidden: document.getElementById('boardList').hidden, emptyHidden: document.getElementById('boardEmpty').hidden, note: !document.getElementById('boardNote').hidden, priv: document.getElementById('boardPrivacy').hidden ? '' : document.getElementById('boardPrivacy').textContent }));
      check(G, 'opening Top 5 online shows "Loading..." (not the empty state), the shared heading "Top 5, all players" and the public-data note while the request is out',
        L.open && L.loading && L.loadTxt === 'Loading...' && L.listHidden && L.emptyHidden && !L.note && L.head === 'Top 5, all players' && L.priv === 'Names and scores on this board are public.', L);
      await until(async () => !(await page.evaluate(() => document.getElementById('boardList').hidden)), 5000);
      const U = await page.evaluate(() => ({ rows: Array.from(document.querySelectorAll('#boardList li')).map((l) => l.textContent), imgs: document.querySelectorAll('#board img, #boardList img').length, html: document.getElementById('boardList').innerHTML, loading: !document.getElementById('boardLoading').hidden, note: !document.getElementById('boardNote').hidden, me: document.querySelectorAll('#boardList li[aria-current]').length, yours: !document.getElementById('boardYours').hidden, aria: document.getElementById('boardList').getAttribute('aria-label') }));
      check(G, 'a server name like <img onerror=...> is shown as text (no element is created, no dialog, no script ran) and the list has the four good rows',
        U.rows.length === 4 && /<img onerror/.test(U.rows[1]) && U.imgs === 0 && /&lt;img onerror/.test(U.html) && dialogs.length === 0 && !U.loading && !U.note && /Top 5 fares, all players/.test(U.aria), U);
      check(G, 'with no local uid nothing is highlighted and there is no "Your best" line', U.me === 0 && U.yours === false);
      await page.keyboard.press('Escape');

      /* highlight own row, and the "Your best" line when the player is not in the shared top 5 */
      st.queryDelay = 0; st.rawQuery = null;
      st.db = { uidAAAA1: { name: 'Wanjiru K', score: 90000 }, uidBBBB2: { name: 'Baraka', score: 80000 }, mockuid1: { name: 'Mama Pima', score: 5000 } };
      await page.evaluate(() => { localStorage.setItem('matatuRush.auth', JSON.stringify({ uid: 'mockuid1', refreshToken: 'rt-x' })); localStorage.setItem('matatuRush.onlineBest', '5000'); });
      await page.reload(); await page.waitForFunction(() => !!window.MatatuRush);
      await page.click('#btnBoard');
      await until(async () => !(await page.evaluate(() => document.getElementById('boardList').hidden)), 5000);
      const H = await page.evaluate(() => ({ cur: Array.from(document.querySelectorAll('#boardList li[aria-current="true"]')).map((l) => ({ t: l.querySelector('.nm').textContent, cls: l.className })), yours: !document.getElementById('boardYours').hidden }));
      check(G, 'the row whose id equals the local uid gets aria-current="true" and the highlight class; no "Your best" line when the player is in the list', H.cur.length === 1 && H.cur[0].t === 'Mama Pima' && H.cur[0].cls === 'me' && H.yours === false, H);
      await page.keyboard.press('Escape');
      st.db = { a1: { name: 'A', score: 90000 }, a2: { name: 'B', score: 80000 }, a3: { name: 'C', score: 70000 }, a4: { name: 'D', score: 60000 }, a5: { name: 'E', score: 50000 } };
      await page.evaluate(() => localStorage.setItem('matatuRush.onlineBest', '4321'));
      await page.click('#btnBoard');
      await until(async () => !(await page.evaluate(() => document.getElementById('boardList').hidden)), 5000);
      const Y = await page.evaluate(() => ({ rows: document.querySelectorAll('#boardList li').length, me: document.querySelectorAll('#boardList li[aria-current]').length, yours: document.getElementById('boardYours').hidden ? '' : document.getElementById('boardYours').textContent }));
      check(G, 'a player outside the shared top 5 sees one extra line "Your best: KSh 4,321" under the list', Y.rows === 5 && Y.me === 0 && Y.yours === 'Your best: KSh 4,321', Y);
      await page.keyboard.press('Escape');

      /* layout: the online sheet fits small screens (text at 14 px or more, Close reachable) */
      for (const [w, h] of [[320, 568], [844, 390]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.click('#btnBoard');
        await until(async () => !(await page.evaluate(() => document.getElementById('boardList').hidden)), 5000);
        const fit = await page.evaluate(() => {
          const root = document.getElementById('board');
          const nodes = Array.from(root.querySelectorAll('*')).filter((n) => n.offsetParent !== null && Array.from(n.childNodes).some((c) => c.nodeType === 3 && c.textContent.trim()));
          const small = nodes.filter((n) => parseFloat(getComputedStyle(n).fontSize) < 14).map((n) => n.id || n.className || n.tagName);
          const btn = document.getElementById('btnBoardClose'); btn.scrollIntoView({ block: 'nearest' });
          const r = btn.getBoundingClientRect();
          return { small, closeIn: r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth, noScroll: root.scrollHeight <= root.clientHeight + 1, sideways: root.scrollWidth > root.clientWidth + 1, n: nodes.length };
        });
        check(G, 'online Top 5 sheet at ' + w + 'x' + h + ': all text 14 px or more, no sideways scroll, Close button can be brought fully on screen', fit.small.length === 0 && fit.closeIn && !fit.sideways && fit.n > 8, fit);
        await page.keyboard.press('Escape');
      }
      await page.setViewportSize({ width: 1280, height: 720 });

      /* failure and empty states */
      await page.evaluate(() => localStorage.setItem('matatuRush.top5', JSON.stringify([{ name: 'Local One', score: 777, id: 'l1' }, { name: 'Local Two', score: 500, id: 'l2' }])));
      st.queryStatus = 500; st.queryDelay = 400;
      await page.reload(); await page.waitForFunction(() => !!window.MatatuRush);
      await page.click('#btnBoard');
      await sleep(120);
      const mid = await page.evaluate(() => !document.getElementById('boardLoading').hidden);
      await until(async () => !(await page.evaluate(() => document.getElementById('boardNote').hidden)), 5000);
      const E = await page.evaluate(() => ({ note: document.getElementById('boardNote').textContent, head: document.getElementById('boardH').textContent, rows: Array.from(document.querySelectorAll('#boardList li')).map((l) => l.textContent), priv: !document.getElementById('boardPrivacy').hidden, loading: !document.getElementById('boardLoading').hidden, aria: document.getElementById('boardList').getAttribute('aria-label') }));
      check(G, 'when the shared board cannot be fetched (HTTP 500) the sheet shows this device\'s own list, the heading "TOP 5" and the note "Offline. Showing this device only."; Loading is gone',
        mid && E.note === 'Offline. Showing this device only.' && E.head === 'TOP 5' && E.rows.length === 2 && /Local One/.test(E.rows[0]) && !E.priv && !E.loading && /on this device/.test(E.aria), { mid, E });
      await page.keyboard.press('Escape');
      st.queryStatus = 200; st.queryDelay = 0; st.rawQuery = [{ readTime: 't' }];
      await page.click('#btnBoard');
      await until(async () => !(await page.evaluate(() => document.getElementById('boardEmpty').hidden)), 5000);
      const Em = await page.evaluate(() => ({ empty: !document.getElementById('boardEmpty').hidden, list: document.getElementById('boardList').hidden, note: !document.getElementById('boardNote').hidden }));
      check(G, 'an empty shared board shows the "No fares yet" message, not an error note', Em.empty && Em.list && !Em.note, Em);
      await page.keyboard.press('Escape');
      /* closing the sheet while the request is out: the late answer must not reopen or repaint it */
      st.queryDelay = 700; st.rawQuery = null; st.db = { zz: { name: 'Late', score: 1 } };
      await page.click('#btnBoard'); await sleep(100); await page.keyboard.press('Escape'); await sleep(1000);
      check(G, 'closing the sheet while the request is in the air: the late answer changes nothing visible', await page.evaluate(() => document.getElementById('board').hidden));
      await ctx.close();
    }

    /* ---- the pending record, rate limit and token reuse through the public API ---- */
    {
      const { ctx, page, st } = await mk({ label: 'online-api' });
      await page.goto(base + '/index.html?seed=7');
      await page.waitForFunction(() => !!window.MatatuRush);
      const call = (expr) => page.evaluate((e) => new Promise((res) => { const cb = (err, val) => res({ err, val }); (new Function('cb', 'return ' + e))(cb); }), expr);
      const a = await call("MR.online.submit('Mama Pima', 1000, cb, 'Dere 111')");
      const b = await call("MR.online.submit('Mama Pima', 2000, cb, 'Dere 111')");
      const fa = commitFields(st.commits[0] || {}), fb = commitFields(st.commits[1] || {});
      check(G, 'sign-up happens once and the access token is reused: two sends, one signUp, no refresh, same Bearer token and same document',
        a.err === null && b.err === null && st.signups === 1 && st.refreshes === 0 && st.commits.length === 2 && st.commits[0].auth === 'Bearer id-1' && st.commits[1].auth === 'Bearer id-1' && fa.doc === fb.doc && /\/scores\/mockuid1$/.test(fa.doc) && fb.score === '2000', { a, b, signups: st.signups, refreshes: st.refreshes, auth: st.commits.map((c) => c.auth) });
      const signLog = st.log.find((l) => l.path.endsWith('/accounts:signUp'));
      check(G, 'sign-up request: POST to the identitytoolkit host /v1/accounts:signUp?key=... with {"returnSecureToken":true}; the uid and refresh token are stored under matatuRush.auth',
        !!signLog && signLog.host === 'identitytoolkit.googleapis.com' && signLog.method === 'POST' && signLog.search === '?key=' + ON_KEY && JSON.parse(signLog.body).returnSecureToken === true && JSON.stringify(await lsJson(page, 'matatuRush.auth')) === JSON.stringify({ uid: 'mockuid1', refreshToken: 'rt-1' }), signLog);
      const nameChecks = [
        ['non-ASCII name', "MR.online.submit('Wanjir\\u00fa', 3000, cb, 'Konda 222')", 'Konda 222'],
        ['blocklisted name (upper case)', "MR.online.submit('SHIT HEAD', 3001, cb, 'Rubani 333')", 'Rubani 333'],
        ['blocklisted word as its own token', "MR.online.submit('xx fuck xx', 3002, cb, 'Makanga 444')", 'Makanga 444'],
        ['real name that only CONTAINS a listed string (Kumar) is kept', "MR.online.submit('Kumar', 3005, cb, 'Makanga 445')", 'Kumar'],
        ['HTML in the name', "MR.online.submit('<b>hi</b>', 3003, cb, 'Dere 555')", 'Dere 555'],
        ['padded name: trimmed, spaces collapsed, kept', "MR.online.submit('   Wambui   K  ', 3004, cb, 'Dere 666')", 'Wambui K']
      ];
      const sent = [];
      for (const [, expr] of nameChecks) { const before = st.commits.length; await call(expr); sent.push(st.commits.length === before + 1 ? commitFields(st.commits[st.commits.length - 1]).name : null); }
      check(G, 'submit() sends the alias instead of a non-ASCII, blocklisted (any case, whole word) or HTML name; a clean name (even one that merely contains a listed string) is trimmed and kept',
        JSON.stringify(sent) === JSON.stringify(nameChecks.map((x) => x[2])), sent);
      const bad = await Promise.all([call("MR.online.submit('Bob', 0, cb, 'Dere 111')"), call("MR.online.submit('Bob', 5000001, cb, 'Dere 111')"), call("MR.online.submit('fuck', 10, cb, 'shit')")]);
      check(G, 'submit() refuses (and sends nothing) for a zero score, a score above the cap, and a bad name with a bad alias', bad[0].err === 'badscore' && bad[1].err === 'badscore' && bad[2].err === 'badname' && st.commits.length === 2 + nameChecks.length, bad);
      const cf = fa;
      check(G, 'commit body: one write, update of scores/{uid} with name (string) and score (integer as a string), updateTransforms ts = REQUEST_TIME, no updateMask, no precondition, key in the URL',
        cf && cf.nwrites === 1 && JSON.stringify(cf.keys.sort()) === JSON.stringify(['update', 'updateTransforms']) && JSON.stringify(cf.fkeys.sort()) === JSON.stringify(['name', 'score']) && cf.name === 'Mama Pima' && cf.score === '1000' && JSON.stringify(cf.tr) === JSON.stringify([{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }]) && st.commits[0].search === '?key=' + ON_KEY && st.commits[0].host === 'firestore.googleapis.com' && st.commits[0].path === '/v1/projects/' + ON_PROJECT + '/databases/(default)/documents:commit', cf);
      await ctx.close();
    }
    {
      /* rate limit: a second flush inside the window is delayed, not sent. The page gets a hand-driven clock (window.__clk) and a
         300 ms window, so nothing depends on real 11 s waits. The wait is ONE window at most (one timer of about 350 ms): the clock
         here is frozen on purpose, and the write still leaves after that one wait, because a wait is never repeated (a stuck or
         moved clock must not lock the device out). */
      const { ctx, page, st } = await mk({ label: 'online-rate', delayMs: 300, clock: 5000000 });
      await page.goto(base + '/index.html?seed=7');
      await page.waitForFunction(() => !!window.MatatuRush);
      await page.evaluate(() => { window.__fl = []; MR.online.queue({ name: 'Dere 111', alias: 'Dere 111', score: 100 }); MR.online.flush((e, v) => window.__fl.push(['f1', e, v && v.sent])); });
      await until(async () => st.commits.length === 1, 5000);
      await until(async () => (await page.evaluate(() => window.__fl.length)) === 1, 3000);
      const stamp1 = parseInt(await lsGet(page, 'matatuRush.lastSend'), 10);
      await page.evaluate(() => { MR.online.queue({ name: 'Dere 111', alias: 'Dere 111', score: 200 }); MR.online.flush((e, v) => window.__fl.push(['f2', e, v && v.sent])); MR.online.flush((e) => window.__fl.push(['f3', e])); });
      await sleep(120); /* well inside the one 350 ms wait; the clock has not moved */
      const early = st.commits.length;
      const busy = await page.evaluate(() => window.__fl.filter((x) => x[0] === 'f3').map((x) => x[1]));
      await until(async () => st.commits.length === 2, 5000); /* the one wait ends, the frozen clock notwithstanding */
      const stamp2 = parseInt(await lsGet(page, 'matatuRush.lastSend'), 10);
      check(G, 'a second flush inside the rate window is delayed, not sent (nothing while the one window wait is running), a third call meanwhile is refused as busy, and the delayed one goes out after that ONE wait even when the injected clock never moves (no repeated waiting)',
        stamp1 === 5000000 && early === 1 && busy.length === 1 && busy[0] === 'busy' && st.commits.length === 2 && stamp2 === 5000000 && commitFields(st.commits[1]).score === '200', { stamp1, early, busy, stamp2, n: st.commits.length });
      await ctx.close();
    }
    {
      /* nothing is requested while the game is PAUSED (only the title and game over screens may talk to the network) */
      const { ctx, page, st } = await mk({ label: 'online-pause' });
      await page.goto(base + '/index.html?seed=20');
      await page.waitForFunction(() => !!window.MatatuRush);
      await page.keyboard.press('Enter');
      await waitFor(page, (x) => x.mode === 'running', 4000, 'pause run');
      await page.keyboard.press('p');
      await waitFor(page, (x) => x.mode === 'paused', 4000, 'paused');
      const before = st.log.length, xb = (await xhrLog(page)).length;
      const r = await page.evaluate(() => new Promise((res) => {
        const out = {};
        MR.online.queue({ name: 'Dere 111', alias: 'Dere 111', score: 123456 });
        MR.online.top((e) => { out.top = e; MR.online.flush((e2) => { out.flush = e2; MR.online.submit('Bob', 99, (e3) => { out.submit = e3; res(out); }, 'Dere 111'); }); });
      }));
      await sleep(300);
      check(G, 'while PAUSED top(), flush() and submit() all refuse with "running" and no request leaves (guard allows only the title and game over screens)',
        r.top === 'running' && r.flush === 'running' && r.submit === 'running' && st.log.length === before && (await xhrLog(page)).length === xb, { r, before, now: st.log.length });
      await ctx.close();
    }

    /* ---- real runs: queue at game over, send on Save / Skip / Play again / Menu, failures ---- */
    const runScenarios = [];
    /* G1: Save with a typed name */
    runScenarios.push((async () => {
      const { ctx, page, st, dialogs } = await mk({ label: 'online-save' });
      st.db = { uidTop1: { name: 'Wanjiru K', score: 100000 }, uidLow1: { name: 'Tiny', score: 1 } };
      const s = await idleToOver(page, base);
      await until(async () => (await page.evaluate(() => document.querySelectorAll('#overBoard li').length)) === 2, 5000);
      const pend = await lsJson(page, 'matatuRush.pending');
      const alias = await page.evaluate(() => document.getElementById('nameInput').placeholder);
      const ui0 = await page.evaluate(() => ({ head: document.getElementById('overBoardH').textContent, pub: document.getElementById('namePublic').hidden ? '' : document.getElementById('namePublic').textContent, rows: document.querySelectorAll('#overBoard li').length, form: !document.getElementById('nameForm').hidden }));
      check(G, 'game over with a new local best: the run is queued at once under its alias (pending = alias, alias, score); nothing is sent yet; the shared list and the public-data note show on the over screen',
        s.screen === 'over' && s.score > 0 && !!pend && pend.name === alias && pend.alias === alias && ON_ALIAS.test(alias) && pend.score === s.score && st.commits.length === 0 && st.signups === 0 && ui0.form && ui0.head === 'Top 5, all players' && ui0.rows === 2 && ui0.pub === 'Names and scores on this board are public.', { s: s.score, pend, alias, commits: st.commits.length, ui0 });
      await page.fill('#nameInput', 'Mama Pima');
      await page.keyboard.press('Enter');
      await until(async () => st.commits.length === 1, 6000);
      await until(async () => (await page.evaluate(() => document.querySelectorAll('#overBoard li[aria-current]').length)) === 1, 6000);
      const f = commitFields(st.commits[0] || {});
      const after = await page.evaluate(() => ({ cur: Array.from(document.querySelectorAll('#overBoard li[aria-current="true"]')).map((l) => ({ t: l.querySelector('.nm').textContent, c: l.className })), rows: Array.from(document.querySelectorAll('#overBoard li')).map((l) => l.textContent), saved: document.getElementById('nameSaved').textContent }));
      const xs = await xhrLog(page);
      check(G, 'Save with a typed name sends exactly one commit: typed name, integer score of the run, ts = REQUEST_TIME; one sign-up; the Bearer token is the one just issued',
        st.commits.length === 1 && !!f && f.name === 'Mama Pima' && f.score === String(s.score) && /^\d+$/.test(f.score) && JSON.stringify(f.tr) === JSON.stringify([{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }]) && st.signups === 1 && st.commits[0].auth === 'Bearer id-1' && /\/scores\/mockuid1$/.test(f.doc), { f, signups: st.signups });
      check(G, 'after the send the pending record is gone, onlineBest equals the score, and the over list is re-fetched and highlights this player (aria-current, class me) under the typed name',
        (await lsGet(page, 'matatuRush.pending')) === '' && (await lsGet(page, 'matatuRush.onlineBest')) === String(s.score) && after.cur.length === 1 && after.cur[0].t === 'Mama Pima' && after.cur[0].c === 'me' && after.rows.length === 3 && st.queries.length >= 2, { after, q: st.queries.length });
      check(G, 'nothing was requested while the mode was "running" (every request was made at the title or game over)', xs.length >= 3 && xs.every((x) => x.mode !== 'running' && x.mode !== 'paused'), xs.map((x) => x.mode + ' ' + x.u.replace(/\?.*/, '').split('/').pop()));
      check(G, 'no dialog and no stray (non-mocked) request on the save flow', dialogs.length === 0 && st.stray.length === 0, { dialogs, stray: st.stray });
      await ctx.close();
    })());
    /* G2: Skip, player outside the shared top 5 */
    runScenarios.push((async () => {
      const { ctx, page, st } = await mk({ label: 'online-skip' });
      st.db = { a1: { name: 'A', score: 90000 }, a2: { name: 'B', score: 80000 }, a3: { name: 'C', score: 70000 }, a4: { name: 'D', score: 60000 }, a5: { name: 'E', score: 50000 } };
      const s = await idleToOver(page, base);
      const alias = await page.evaluate(() => document.getElementById('nameInput').placeholder);
      await page.click('#btnSkipName');
      await until(async () => st.commits.length === 1, 6000);
      const f = commitFields(st.commits[0] || {});
      await until(async () => (await page.evaluate(() => !document.getElementById('overYours').hidden)), 6000);
      const ui = await page.evaluate(() => ({ yours: document.getElementById('overYours').hidden ? '' : document.getElementById('overYours').textContent, rows: document.querySelectorAll('#overBoard li').length, cur: document.querySelectorAll('#overBoard li[aria-current]').length }));
      check(G, 'Skip sends one commit under the alias', st.commits.length === 1 && !!f && f.name === alias && ON_ALIAS.test(f.name) && f.score === String(s.score), { f, alias });
      check(G, 'a score outside the shared top 5: five rows, none highlighted, and the line "Your best: KSh N" under the list on the game over screen',
        ui.rows === 5 && ui.cur === 0 && ui.yours === 'Your best: KSh ' + String(s.score).replace(/\B(?=(\d{3})+(?!\d))/g, ','), { ui, score: s.score });
      await ctx.close();
    })());
    /* G3: a blocklisted typed name */
    runScenarios.push((async () => {
      const { ctx, page, st } = await mk({ label: 'online-block' });
      const s = await idleToOver(page, base);
      const alias = await page.evaluate(() => document.getElementById('nameInput').placeholder);
      await page.fill('#nameInput', 'Fuck Off');
      await page.click('#btnSaveName');
      await until(async () => st.commits.length === 1, 6000);
      const f = commitFields(st.commits[0] || {});
      const local = await lsJson(page, 'matatuRush.top5');
      check(G, 'a typed blocklisted name ("Fuck Off") is sent as the alias, not as typed (the local board keeps what the player typed)', !!f && f.name === alias && !/fuck/i.test(JSON.stringify(st.commits[0].body)) && local && local[0].name === 'Fuck Off' && f.score === String(s.score), { f, alias, local });
      const saved = await page.evaluate(() => ({ t: document.getElementById('nameSaved').textContent, live: document.getElementById('live').textContent }));
      check(G, 'the player is told when the shared board cannot use the typed name: "Saved as Fuck Off on this device. Shared board shows <alias>." (also in the live region), not a silent swap',
        saved.t === 'Saved as Fuck Off on this device. Shared board shows ' + alias + '.' && saved.live.indexOf('Shared board shows ' + alias) !== -1, { saved, alias });
      await ctx.close();
    })());
    /* G4: Play again with the form untouched; the next run is never interrupted; sent at its end */
    runScenarios.push((async () => {
      const { ctx, page, st } = await mk({ label: 'online-again' });
      const s = await idleToOver(page, base);
      const alias = await page.evaluate(() => document.getElementById('nameInput').placeholder);
      await sleep(700);
      await page.click('#btnAgain');
      await waitFor(page, (x) => x.mode === 'running', 4000, 'second run');
      await until(async () => st.signups === 1, 3000);
      await sleep(1200);
      const mid = await xhrLog(page);
      const pend = await lsJson(page, 'matatuRush.pending');
      check(G, 'Play again with the form untouched: the start-of-run flush asks for sign-up before the run starts, but nothing is sent once the run is going (the commit waits; the record stays pending)',
        st.signups === 1 && st.commits.length === 0 && !!pend && pend.name === alias && mid.length >= 1 && mid.every((x) => x.mode !== 'running'), { signups: st.signups, commits: st.commits.length, pend, modes: mid.map((x) => x.mode) });
      await page.waitForSelector('#over:not([hidden])', { timeout: 70000 });
      await sleep(150);
      await page.click('#btnSkipName');
      await until(async () => st.commits.length === 1, 6000);
      const f = commitFields(st.commits[0] || {});
      const all = await xhrLog(page);
      check(G, 'after the second run the pending alias of the FIRST run goes out (the older record was kept: same score, not replaced), still nothing while running', !!f && f.name === alias && f.score === String(s.score) && all.every((x) => x.mode !== 'running'), { f, alias, modes: all.map((x) => x.mode) });
      await ctx.close();
    })());
    /* G5: network down at Save; pending survives; Menu sends it */
    runScenarios.push((async () => {
      const { ctx, page, st } = await mk({ label: 'online-net' });
      st.net = true;
      const s = await idleToOver(page, base);
      const alias = await page.evaluate(() => document.getElementById('nameInput').placeholder);
      const over = await page.evaluate(() => ({ note: document.getElementById('overNote').hidden ? '' : document.getElementById('overNote').textContent, head: document.getElementById('overBoardH').textContent, rows: Array.from(document.querySelectorAll('#overBoard li')).map((l) => l.textContent), loading: !document.getElementById('overLoading').hidden }));
      check(G, 'game over with the network down: the over screen shows this device\'s list, heading "Top 5" and the note "Offline. Showing this device only."; Loading is gone',
        over.note === 'Offline. Showing this device only.' && over.head === 'Top 5' && over.rows.length === 1 && !over.loading, over);
      await page.fill('#nameInput', 'Baraka');
      await page.keyboard.press('Enter');
      await sleep(1500);
      const hits = st.netHits;
      await sleep(2500);
      const pend = await lsJson(page, 'matatuRush.pending');
      check(G, 'network down at Save: the record stays pending with the typed name, nothing is committed, and there is no retry loop (request count unchanged after 2.5 s)',
        !!pend && pend.name === 'Baraka' && pend.score === s.score && st.commits.length === 0 && hits >= 1 && st.netHits === hits && (await lsGet(page, 'matatuRush.onlineBest')) !== String(s.score), { pend, hits, now: st.netHits });
      st.net = false;
      await page.click('#btnMenu');
      await until(async () => st.commits.length === 1, 6000);
      const f = commitFields(st.commits[0] || {});
      await until(async () => (await lsGet(page, 'matatuRush.pending')) === '', 4000);
      const xs = await xhrLog(page);
      check(G, 'Menu (back to the title) flushes the pending record: the typed name goes out once the network is back', !!f && f.name === 'Baraka' && f.score === String(s.score) && xs.every((x) => x.mode !== 'running') && (await lsGet(page, 'matatuRush.pending')) === '', { f });
      await ctx.close();
    })());
    /* G6: 403 (rules said no, or "too soon"): keep the record, retry once per window, drop after 3 attempts. 100 ms-scale window via delayMs. */
    runScenarios.push((async () => {
      const { ctx, page, st } = await mk({ label: 'online-403', delayMs: 1200 });
      st.commitStatus = 403;
      const s = await idleToOver(page, base);
      await page.fill('#nameInput', 'Rejected');
      await page.keyboard.press('Enter');
      await until(async () => st.commits.length === 1, 6000);
      await sleep(500);
      const p1 = await lsJson(page, 'matatuRush.pending');
      check(G, 'a first 403 keeps the pending record (attempts 1), does not raise onlineBest and sends nothing more at once (no tight loop)',
        st.commits.length === 1 && !!p1 && p1.attempts === 1 && p1.name === 'Rejected' && (await lsGet(page, 'matatuRush.onlineBest')) === '0', { n: st.commits.length, p1 });
      await until(async () => st.commits.length === 3, 12000);
      await sleep(2500); /* longer than a window: a fourth attempt would show now */
      const pend = await lsGet(page, 'matatuRush.pending');
      const gaps = st.commits.map((c) => c.t).slice(1).map((t, i) => t - st.commits[i].t);
      check(G, 'a 403 that never goes away: exactly 3 attempts, each at least one window (1.2 s here) after the previous answer, the record is then dropped, onlineBest is not raised, and a re-read of the own entry (GET) comes before each retry',
        st.commits.length === 3 && pend === '' && gaps.every((g) => g >= 1150) && st.gets.length === 2 && (await lsGet(page, 'matatuRush.onlineBest')) === '0' && st.signups === 1, { n: st.commits.length, pend, gaps, gets: st.gets.length });
      await page.reload(); await page.waitForFunction(() => !!window.MatatuRush);
      await sleep(1500);
      check(G, 'after a reload the dropped record is not resent', st.commits.length === 3, st.commits.length);
      await ctx.close();
    })());
    /* G6b: one "too soon" 403, then the retry goes through and the score is not lost */
    runScenarios.push((async () => {
      const { ctx, page, st } = await mk({ label: 'online-403b', delayMs: 1200 });
      st.failCommits = 1;
      const s = await idleToOver(page, base);
      await page.click('#btnSkipName');
      await until(async () => st.commits.length === 2, 12000);
      await until(async () => (await lsGet(page, 'matatuRush.pending')) === '', 4000);
      const gap = st.commits.length === 2 ? st.commits[1].t - st.commits[0].t : -1;
      check(G, 'one 403 and then success: the same record is retried after the window (one GET in between), is accepted, the pending record is cleared and onlineBest is raised',
        st.commits.length === 2 && st.gets.length === 1 && gap >= 1150 && (await lsGet(page, 'matatuRush.onlineBest')) === String(s.score) && commitFields(st.commits[1]).score === String(s.score), { n: st.commits.length, gets: st.gets.length, gap });
      await ctx.close();
    })());
    /* G6c: HTTP 400 (malformed) is dropped at once and never retried */
    runScenarios.push((async () => {
      const { ctx, page, st } = await mk({ label: 'online-400', delayMs: 1200 });
      st.commitStatus = 400;
      await idleToOver(page, base);
      await page.click('#btnSkipName');
      await until(async () => st.commits.length === 1, 6000);
      await sleep(2800);
      check(G, 'an HTTP 400 drops the pending record at once and nothing is retried', st.commits.length === 1 && (await lsGet(page, 'matatuRush.pending')) === '', { n: st.commits.length });
      await ctx.close();
    })());
    await Promise.all(runScenarios);

    /* ---- pending survives a reload when the network fails, and is sent at the next boot ---- */
    {
      const { ctx, page, st } = await mk({ label: 'online-boot' });
      await page.goto(base + '/index.html?seed=7');
      await page.waitForFunction(() => !!window.MatatuRush);
      await page.evaluate(() => localStorage.setItem('matatuRush.pending', JSON.stringify({ name: 'Wambui K', alias: 'Dere 123', score: 4242 })));
      st.net = true;
      await page.reload(); await page.waitForFunction(() => !!window.MatatuRush);
      await sleep(1000);
      const survived = await lsJson(page, 'matatuRush.pending');
      check(G, 'pending survives a boot with the network down (kept, no commit)', !!survived && survived.score === 4242 && survived.name === 'Wambui K' && st.commits.length === 0 && st.netHits >= 1, { survived, hits: st.netHits });
      st.net = false;
      await page.reload(); await page.waitForFunction(() => !!window.MatatuRush);
      await until(async () => st.commits.length === 1, 6000);
      const f = commitFields(st.commits[0] || {});
      const xs = await xhrLog(page);
      check(G, 'the next boot sends it: one sign-up, one commit with the stored name and score, made at the title (not during a run), pending cleared',
        !!f && f.name === 'Wambui K' && f.score === '4242' && st.signups === 1 && xs.every((x) => x.mode === 'boot' || x.mode === 'title') && (await until(async () => (await lsGet(page, 'matatuRush.pending')) === '', 2000)), { f, modes: xs.map((x) => x.mode) });
      /* a second boot with a stored refresh token uses it (no new sign-up) */
      await page.evaluate(() => localStorage.setItem('matatuRush.pending', JSON.stringify({ name: 'Wambui K', alias: 'Dere 123', score: 5000 })));
      await page.evaluate(() => localStorage.setItem('matatuRush.lastSend', '0'));
      await page.reload(); await page.waitForFunction(() => !!window.MatatuRush);
      await until(async () => st.commits.length === 2, 6000);
      check(G, 'after a reload the stored refresh token is used (POST securetoken /v1/token, form-encoded grant_type=refresh_token) and no second sign-up happens',
        st.signups === 1 && st.refreshes === 1 && st.commits.length === 2 && /grant_type=refresh_token&refresh_token=rt-1/.test((st.log.find((l) => l.path === '/v1/token') || {}).body || '') && st.commits[1].auth === 'Bearer id-r1', { signups: st.signups, refreshes: st.refreshes });
      /* an invalid refresh token: sign up again, once */
      await page.evaluate(() => { localStorage.setItem('matatuRush.pending', JSON.stringify({ name: 'Wambui K', alias: 'Dere 123', score: 6000 })); localStorage.setItem('matatuRush.lastSend', '0'); });
      st.tokenStatus = 400;
      await page.reload(); await page.waitForFunction(() => !!window.MatatuRush);
      await until(async () => st.commits.length === 3, 6000);
      const au = await lsJson(page, 'matatuRush.auth');
      check(G, 'an invalid refresh token (HTTP 400) makes the client sign up again once and still send', st.signups === 2 && st.refreshes === 2 && st.commits.length === 3 && au && au.uid === 'mockuid2' && /\/scores\/mockuid2$/.test(commitFields(st.commits[2]).doc), { signups: st.signups, refreshes: st.refreshes, au });
      /* a refresh answered 403 (API key that does not allow the Token Service API): also one fresh sign-up, then the send */
      await page.evaluate(() => { localStorage.setItem('matatuRush.pending', JSON.stringify({ name: 'Wambui K', alias: 'Dere 123', score: 7000 })); localStorage.setItem('matatuRush.lastSend', '0'); });
      st.tokenStatus = 403;
      await page.reload(); await page.waitForFunction(() => !!window.MatatuRush);
      await until(async () => st.commits.length === 4, 6000);
      const au3 = await lsJson(page, 'matatuRush.auth');
      check(G, 'a refresh answered HTTP 403 makes the client sign up again once (new id) and still send under the new id', st.signups === 3 && st.refreshes === 3 && st.commits.length === 4 && au3 && au3.uid === 'mockuid3' && /\/scores\/mockuid3$/.test(commitFields(st.commits[3]).doc), { signups: st.signups, refreshes: st.refreshes, au3 });
      await ctx.close();
    }
    {
      /* a run that starts while a token refresh is still in the air: the commit is held back until the run is over */
      const { ctx, page, st } = await mk({ label: 'online-hold' });
      await page.goto(base + '/index.html?seed=20');
      await page.waitForFunction(() => !!window.MatatuRush);
      await page.evaluate(() => { localStorage.setItem('matatuRush.auth', JSON.stringify({ uid: 'mockuid1', refreshToken: 'rt-1' })); localStorage.setItem('matatuRush.pending', JSON.stringify({ name: 'Held Back', alias: 'Dere 999', score: 1500 })); localStorage.setItem('matatuRush.lastSend', '0'); });
      st.tokenDelay = 1500;
      await page.reload(); await page.waitForFunction(() => !!window.MatatuRush);
      await page.keyboard.press('Enter');
      await waitFor(page, (x) => x.mode === 'running', 4000, 'hold run');
      await until(async () => st.refreshes === 1, 3000);
      await sleep(2800);
      const mid = await xhrLog(page);
      check(G, 'a refresh started at boot and answered during a run does not lead to a commit during the run; the record stays pending', st.refreshes === 1 && st.commits.length === 0 && (await lsJson(page, 'matatuRush.pending')) && mid.every((x) => x.mode !== 'running'), { commits: st.commits.length, modes: mid.map((x) => x.mode) });
      await page.waitForSelector('#over:not([hidden])', { timeout: 70000 });
      await sleep(150);
      await page.click('#btnSkipName');
      await until(async () => st.commits.length === 1, 6000);
      const all = await xhrLog(page);
      check(G, 'the held record goes out after the run ends, with its own stored name, and no request ever carried mode "running"', st.commits.length === 1 && commitFields(st.commits[0]).name === 'Held Back' && all.every((x) => x.mode !== 'running'), { n: st.commits.length, modes: all.map((x) => x.mode) });
      await ctx.close();
    }

    /* ---- network report for the whole group ---- */
    const hosts = new Set(); let strays = [];
    for (const m of allMocks) { for (const l of m.log) hosts.add(l.host); strays = strays.concat(m.stray); }
    check(G, 'every Google request made by the online pages went to one of the three default hosts and was answered by the mock (no real network, no other host)',
      strays.length === 0 && Array.from(hosts).every((h) => ON_HOSTS.indexOf(h) !== -1) && hosts.size === 3, { hosts: Array.from(hosts), strays });
  } finally {
    srv.close();
  }
}

if (require.main !== module) { module.exports = { loadPlaywright, smallScreenChecks, nearMissAndRepair, layoutChecks, onlineNodeChecks, onlineSimChecks, onlineBrowserChecks, results, problems }; return; }

(async () => {
  const { pw, from } = loadPlaywright();
  /* the throttling flags only stop headless Chrome from slowing requestAnimationFrame on a page it thinks is in the background */
  const launchOpts = { headless: !process.env.HEADED, args: ['--autoplay-policy=user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] };
  let browser, browserName;
  try { browser = await pw.chromium.launch(Object.assign({ channel: 'chrome' }, launchOpts)); browserName = 'system Google Chrome'; }
  catch (e) { browser = await pw.chromium.launch(launchOpts); browserName = 'Playwright Chromium'; }
  console.log('Playwright from ' + from + ', browser: ' + browserName + ' ' + browser.version());
  console.log('Game URL: ' + URL + '\n');
  const desktop = { viewport: { width: 1280, height: 720 } };
  const notes = {};
  const NM_SEED = 21;

  /* ONLY=online runs just the online group (Node checks, fake-world checks, mocked browser pages) and writes no report files */
  if (process.env.ONLY) {
    if (process.env.ONLY !== 'online') { console.error('ONLY must be "online" (the only group that can run alone)'); await browser.close(); process.exit(2); }
    console.log('ONLY=online: running the online group only');
    onlineNodeChecks();
    onlineSimChecks();
    await onlineBrowserChecks(browser, desktop);
    await browser.close();
    const bad = results.filter((r) => !r.ok);
    const clean1 = problems.consoleErrors.length === 0 && problems.pageErrors.length === 0;
    console.log('\nONLY=online: ' + (results.length - bad.length) + '/' + results.length + ' checks passed' + (clean1 ? '' : ', console errors: ' + JSON.stringify(problems.consoleErrors.concat(problems.pageErrors))));
    if (bad.length) console.log('FAILED:\n' + bad.map((f) => ' - [' + f.group + '] ' + f.name + ' ' + f.detail).join('\n'));
    process.exit(bad.length || !clean1 ? 1 : 0);
  }

  /* ===== 1. Title, offline, no audio before gesture ===== */
  console.log('1. Title screen / offline / no audio before gesture');
  {
    const ctx = await browser.newContext(desktop);
    const page = await ctx.newPage(); watch(page, 'title');
    await page.goto(URL);
    await page.waitForFunction(() => !!window.MatatuRush);
    await fontsReady(page);
    await sleep(1200);
    const s = await snap(page);
    check('title', 'opens from file:// with title screen', s.mode === 'title' && s.screen === 'title' && await page.isVisible('#btnStart'), { mode: s.mode });
    check('title', 'no AudioContext exists before any gesture', s.audio.created === false && s.audio.state === 'none', s.audio);
    const text = await page.evaluate(() => document.body.innerText);
    check('title', 'controls are explained on the title', /switch lane/i.test(text) && /horn nitro/i.test(text) && /pause/i.test(text) && /mute/i.test(text) && /Touch:/i.test(text));
    check('title', 'mute control present on title', await page.isVisible('#btnMute'));
    const names = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()));
    check('a11y', 'every button has an accessible name', names.every((n) => n.length > 0), names.length + ' buttons');
    check('a11y', 'start button has focus, live region exists', await page.evaluate(() => document.activeElement && document.activeElement.id === 'btnStart' && !!document.querySelector('[aria-live]')));
    await page.screenshot({ path: path.join(SHOTS, '01-title-desktop.png') });
    await ctx.close();
  }
  {
    const files = ['index.html', 'css/style.css', 'js/core.js', 'js/game.js', 'js/config.js', 'js/online.js', 'js/audio.js', 'js/art.js', 'js/render.js', 'js/main.js'];
    const bad = [], net = [], fontUrls = [], impact = [];
    /* js/online.js is the ONLY file allowed to touch the network: XMLHttpRequest, and exactly these three https origins */
    const ONLINE_HOSTS = ['https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com', 'https://firestore.googleapis.com'];
    const onlineUrls = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      if (/[\u2014\u2013]/.test(src)) bad.push(f);
      /* the only url() allowed anywhere is a relative link from css/style.css to a bundled .ttf in fonts/ */
      let scan = src;
      if (f === 'css/style.css') {
        scan = src.replace(/url\("\.\.\/fonts\/([A-Za-z0-9-]+\.ttf)"\)/g, (m, name) => { fontUrls.push(name); return 'LOCALFONT'; });
      }
      if (f === 'js/online.js') {
        /* relaxed for this file only: every absolute URL must be exactly one of the three hosts, and XHR / fetch( are allowed.
           WebSocket, //cdn, @import, <img>, <audio>, <video> and url( are still rejected here like everywhere else. */
        const urls = scan.match(/https?:\/\/[^\s'"`)]*/gi) || [];
        for (const u of urls) { onlineUrls.push(u); if (ONLINE_HOSTS.indexOf(u) === -1) net.push(f + ' (url ' + u + ')'); }
        scan = scan.replace(/https?:\/\/[^\s'"`)]*/gi, 'ALLOWEDHOST').replace(/fetch\(|XMLHttpRequest/g, 'ALLOWEDXHR');
      }
      if (/https?:\/\/|\/\/cdn|@import|fetch\(|XMLHttpRequest|WebSocket|<img|<audio|<video|url\(/i.test(scan)) net.push(f);
      if (/\bImpact\b|Haettenschweiler/.test(src)) impact.push(f);
    }
    const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
    const small = [];
    css.replace(/font(?:-size)?\s*:\s*([^;}]+)/g, (m, val) => { (val.match(/(\d+(?:\.\d+)?)px/g) || []).forEach((px) => { if (parseFloat(px) < 14) small.push(m.trim()); }); return m; });
    const faces = (css.match(/@font-face/g) || []).length;
    const fontsOk = fontUrls.length === 4 && faces === 4 && fontUrls.every((n) => fs.existsSync(path.join(ROOT, 'fonts', n))) &&
      ['OFL-BarlowCondensed.txt', 'OFL-Rajdhani.txt'].every((n) => fs.existsSync(path.join(ROOT, 'fonts', n)));
    check('static', 'fonts: four @font-face rules, each a relative url to a bundled .ttf that exists, OFL texts present, no Impact left', fontsOk && impact.length === 0, { fontUrls, impact });
    check('static', 'no font size below 14 px anywhere in css/style.css', small.length === 0, small);
    {
    check('static', 'no em or en dashes anywhere in shipped source (covers all on-screen text)', bad.length === 0, bad);
    check('static', 'no remote URLs, fetch, XHR, image or media tags in shipped source (only local relative font urls allowed; js/online.js alone may use XHR and the three Google hosts)', net.length === 0, net);
    check('static', 'js/online.js names exactly the three Google hosts (identitytoolkit, securetoken, firestore) and no other absolute URL', onlineUrls.length === 3 && ONLINE_HOSTS.every((h) => onlineUrls.indexOf(h) !== -1), onlineUrls);
    check('static', 'inline data: favicon is declared, so http serving never requests /favicon.ico', /<link rel="icon"[^>]*href="data:image\/png;base64,[A-Za-z0-9+\/=]+"/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));
    }
  }

  /* ===== 2. Keyboard controls, audio on gesture, mute, pause ===== */
  console.log('\n2. Human keyboard controls, audio, mute, pause');
  {
    const ctx = await browser.newContext(desktop);
    const page = await ctx.newPage(); watch(page, 'keyboard');
    await page.goto(URL + '?seed=11');
    await page.waitForFunction(() => !!window.MatatuRush);
    await page.keyboard.press('Enter');
    let s = await waitFor(page, (x) => x.mode === 'running', 2000, 'running');
    check('keyboard', 'Enter starts the run', s.mode === 'running' && s.seed === 11 && s.autopilot === false, { seed: s.seed });
    check('audio', 'AudioContext created and running after the start gesture', s.audio.created && s.audio.state === 'running' && s.audio.musicOn, s.audio);
    const lanes = [];
    const press = async (k) => { await page.keyboard.press(k); await sleep(60); const q = await snap(page); lanes.push(k + ':' + q.player.lane); return q; };
    s = await press('ArrowRight'); const a = s.player.lane;
    s = await press('ArrowRight'); const b = s.player.lane;
    s = await press('ArrowRight'); const c = s.player.lane;
    s = await press('ArrowLeft'); const d = s.player.lane;
    s = await press('a'); const e2 = s.player.lane;
    s = await press('a'); const f = s.player.lane;
    s = await press('a'); const g2 = s.player.lane;
    s = await press('d'); const h = s.player.lane;
    check('keyboard', 'Arrow keys and A/D move exactly one lane, clamped at both kerbs', a === 2 && b === 3 && c === 3 && d === 2 && e2 === 1 && f === 0 && g2 === 0 && h === 1, lanes.join(' '));
    await sleep(350);
    s = await snap(page);
    const ev = (await read(page, 0)).e;
    const laneEv = ev.filter((x) => x.type === 'lane'), bumps = ev.filter((x) => x.type === 'bump');
    check('keyboard', 'lane events come from the keyboard source', laneEv.length === 6 && laneEv.every((x) => x.source === 'keyboard') && bumps.length === 2 && s.inputs.keyboard === 8 && s.inputs.autopilot === 0, { lane: laneEv.length, bump: bumps.length, inputs: s.inputs });
    check('keyboard', 'matatu settles in the centre of the chosen lane', Math.abs(s.player.x - s.player.lane) < 0.01, s.player);

    let peak = 0;
    for (let i = 0; i < 25; i++) { peak = Math.max(peak, (await snap(page)).audio.level); await sleep(50); }
    check('audio', 'synth music actually reaches the output (analyser RMS > 0)', peak > 0.005, { peakRms: peak });
    await page.keyboard.press('m');
    await sleep(350);
    let quiet = 0;
    for (let i = 0; i < 12; i++) { quiet = Math.max(quiet, (await snap(page)).audio.level); await sleep(50); }
    s = await snap(page);
    const stored = await page.evaluate(() => localStorage.getItem('matatuRush.muted'));
    check('audio', 'M mutes: output RMS drops to silence and the choice is stored', s.audio.muted === true && quiet < 0.0005 && stored === '1', { rms: quiet, stored });
    check('audio', 'HUD mute button reflects state', await page.getAttribute('#btnMuteHud', 'aria-pressed') === 'true');
    await page.click('#btnMuteHud');
    await sleep(300);
    let back = 0;
    for (let i = 0; i < 20; i++) { back = Math.max(back, (await snap(page)).audio.level); await sleep(50); }
    s = await snap(page);
    check('audio', 'mute button unmutes: sound returns', s.audio.muted === false && back > 0.005, { rms: back });

    if (s.mode === 'running') {
      await page.keyboard.press('p');
      const p1 = await waitFor(page, (x) => x.mode === 'paused', 1500, 'paused');
      await sleep(400);
      const p2 = await snap(page);
      check('pause', 'P pauses: simulation tick frozen, pause screen shown', p1.tick === p2.tick && p2.screen === 'pause' && await page.isVisible('#btnResume'), { tick: p2.tick });
      await page.keyboard.press('p');
      const p3 = await waitFor(page, (x) => x.mode === 'running', 1500, 'resume');
      await sleep(200);
      check('pause', 'P resumes', (await snap(page)).tick > p3.tick - 1 && p3.screen === 'game');
    } else check('pause', 'pause test skipped (run already ended)', false, s.mode);
    await ctx.close();
  }

  /* ===== 3. 26 s keyboard run: pickups, combo, horn, speed ===== */
  console.log('\n3. Keyboard-driven run (about 26 s): pickups, combo, horn nitro, progression');
  {
    const ctx = await browser.newContext(desktop);
    const page = await ctx.newPage(); watch(page, 'run');
    await page.goto(URL + '?seed=7');
    await page.waitForFunction(() => !!window.MatatuRush);
    await page.keyboard.press('Enter');
    const s0 = await waitFor(page, (x) => x.mode === 'running', 2000, 'running');
    let shotPlay = false, shotCombo = false, shotNitro = false, hornPressed = false, secondHorn = false, nitroSpeed = 0, nitroSnap = null;
    const pa = mkPopupAudit(); let runPeak = 0; const states = new Set();
    const run = await drive(page, {
      ms: 26500, mode: 'play', steer: keySteer(page),
      onTick: async (s, newEv) => {
        popupAudit(s, pa); runPeak = Math.max(runPeak, s.audio.level); states.add(s.audio.state);
        if (!shotPlay && s.time > 5.5) { shotPlay = true; await page.screenshot({ path: path.join(SHOTS, '02-gameplay-desktop.png') }); }
        if (!shotCombo && newEv.some((x) => x.type === 'pickup' && x.combo >= 2)) { shotCombo = true; await sleep(90); await page.screenshot({ path: path.join(SHOTS, '03-pickup-combo-desktop.png') }); }
        if (!hornPressed && s.time > 12 && s.horn.ready) { hornPressed = true; await page.keyboard.press('Space'); }
        else if (hornPressed && s.horn.nitro) {
          nitroSpeed = Math.max(nitroSpeed, s.speed / s.baseSpeed);
          if (!nitroSnap && s.horn.nitroTime < 2.2) nitroSnap = s;
          if (!shotNitro && s.horn.nitroTime < 2.0) { shotNitro = true; await page.screenshot({ path: path.join(SHOTS, '04-horn-nitro-desktop.png') }); }
          if (!secondHorn && s.horn.nitroTime < 1.2) { secondHorn = true; await page.keyboard.press('h'); }
        }
      }
    });
    const s = run.s, evs = run.evs;
    const picks = evs.filter((x) => x.type === 'pickup'), hits = evs.filter((x) => x.type === 'hit');
    notes.run = { simSeconds: s.time, dist: s.dist, score: s.score, pickups: picks.length, bestCombo: s.stats.bestCombo, hits: s.stats.hits, nearMiss: s.stats.nearMiss, smashed: s.stats.smashed, speedStart: s0.baseSpeed, speedEnd: s.baseSpeed, keyboardInputs: s.inputs.keyboard, dodged: run.passed.size };
    check('run', 'survived an automated 20 to 30 s input run with real keys', s.time >= 20 && s.time <= 30 && s.mode === 'running', { simSeconds: s.time, mode: s.mode, health: s.health });
    check('run', 'all steering came from keyboard events, none from autopilot', s.inputs.keyboard > 5 && s.inputs.autopilot === 0 && s.autopilot === false, s.inputs);
    check('pickup', 'real passenger pickups happened (>= 3)', picks.length >= 3 && s.stats.pickups === picks.length, { pickups: picks.length, passengers: s.stats.passengers });
    check('pickup', 'every pickup had the matatu physically inside the stage bay', picks.every((x) => Math.abs(x.px - x.lane) <= 0.625 && Math.abs(x.d) <= 1.255), { worstLateral: Math.max.apply(null, picks.map((x) => Math.abs(x.px - x.lane))), worstAhead: Math.max.apply(null, picks.map((x) => Math.abs(x.d))), limits: 'lateral < 0.62, ahead < 1.25 (values rounded to 0.01)' });
    check('combo', 'combo chain built and fares scale with it (fare = 50 x combo, x2 in nitro)', s.stats.bestCombo >= 2 && picks.every((x) => x.fare === 50 * x.mult || x.fare === 100 * x.mult) && picks.some((x) => x.mult >= 2), { bestCombo: s.stats.bestCombo, fares: picks.map((x) => x.fare).slice(0, 8) });
    const fares = picks.reduce((n, x) => n + x.fare, 0), fines = hits.reduce((n, x) => n + x.fine, 0);
    const expected = Math.floor(s.dist) + fares + 25 * evs.filter((x) => x.type === 'nearMiss').length + 10 * evs.filter((x) => x.type === 'smash').length + 25 * evs.filter((x) => x.type === 'repair').length - fines;
    check('run', 'score equals the sum of logged events (distance + fares + bonuses - fines)', Math.abs(expected - s.score) <= 2, { score: s.score, fromEvents: expected });
    check('progress', 'speed escalates during the run', s.baseSpeed > s0.baseSpeed + 0.4, { start: s0.baseSpeed, end: s.baseSpeed });
    check('obstacles', 'pothole, boda boda and askari checkpoint all appeared on the road', ['pothole', 'boda', 'askari', 'stage'].every((t) => run.seenTypes.has(t)), Array.from(run.seenTypes));
    check('fairness', 'obstacles passed in other lanes did no damage', run.passed.size >= 5 && s.health === 3 - hits.length, { dodged: run.passed.size, hits: hits.length, health: s.health });
    const horn = evs.find((x) => x.type === 'horn');
    check('horn', 'Space fires horn nitro from the keyboard when the meter is full', !!horn && horn.source === 'keyboard' && s.stats.horns === 1, horn);
    check('horn', 'nitro drains the meter and boosts speed (> 1.4x base)', !!nitroSnap && nitroSnap.horn.meter === 0 && nitroSpeed > 1.4, { peakSpeedRatio: +nitroSpeed.toFixed(2) });
    check('horn', 'pressing horn again with an empty meter does not re-trigger nitro', evs.some((x) => x.type === 'hornEmpty') && evs.filter((x) => x.type === 'horn').length === 1 && evs.some((x) => x.type === 'nitroEnd'));
    check('shots', 'gameplay, pickup/combo and nitro screenshots captured', shotPlay && shotCombo && shotNitro);
    notes.popupsKeyboardRun = { frames: pa.frames, maxFloats: pa.maxFloats, comboAndFareFrames: pa.both, hornReadyWithPickupFrames: pa.hornWithPickup, slotCopy: pa.copy };
    check('popup', 'keyboard run: no two live floating popups (or the horn slot) ever overlap; combo and fare seen together', pa.frames > 20 && pa.overlaps.length === 0 && pa.both > 0 && pa.floatOffRoad === 0, { frames: pa.frames, comboAndFare: pa.both, maxFloats: pa.maxFloats, overlaps: pa.overlaps });
    check('popup', 'keyboard run: horn status only ever appears in its gutter slot (off the road, clear of the matatu), never in the float stack', pa.slotSeen > 0 && pa.slotBad.length === 0 && pa.hornInFloat === 0 && Object.keys(pa.copy).every((k) => /^HORN (READY!?|CHARGING)$/.test(k)), { slotFrames: pa.slotSeen, copy: pa.copy, bad: pa.slotBad });
    const au = s.audio, fired = au.fired || {};
    notes.audioRun = { state: au.state, statesSeen: Array.from(states), musicOn: au.musicOn, sequencerSteps: au.steps, peakRms: runPeak, sfxFired: fired };
    console.log('  AUDIO  AudioContext state: ' + au.state + ', music on: ' + au.musicOn + ', sequencer steps: ' + au.steps + ', peak RMS: ' + runPeak + ', sfx fired: ' + JSON.stringify(fired));
    check('audio', 'during the run the context stays running, music is sequencing and the output is audible', au.state === 'running' && states.size === 1 && au.musicOn && au.steps > 100 && runPeak > 0.01, { state: au.state, steps: au.steps, peakRms: runPeak });
    check('audio', 'sound effects were triggered by real game events: one pickup sfx per pickup, horn, lane and start', fired.pickup === picks.length && fired.horn === 1 && fired.start === 1 && fired.lane >= 5 && fired.hornShort >= 1, fired);
    await ctx.close();
  }

  /* ===== 4. Collisions with each obstacle type, game over, restart, high score persistence ===== */
  console.log('\n4. Collisions (all three obstacle types), game over, restart, persistence');
  {
    const ctx = await browser.newContext(desktop);
    const page = await ctx.newPage(); watch(page, 'collide');
    await page.goto(URL + '?seed=5');
    await page.waitForFunction(() => !!window.MatatuRush);
    const want = new Set(['pothole', 'boda', 'askari']);
    const allHits = [], runs = [];
    let overFonts = null;
    let badGeom = 0, badHealth = 0, badGrace = 0, shotOver = false, bestSoFar = 0, restartOk = true, overUiOk = true, bestOk = true;
    for (let r = 0; r < 5 && (want.size > 0 || r < 2); r++) {
      if (r === 0) await page.keyboard.press('Enter');
      else { await sleep(750); await skipNameIfShown(page); await page.keyboard.press(r % 2 ? 'Enter' : 'r'); }
      const st = await waitFor(page, (x) => x.mode === 'running', 3000, 'run ' + r);
      if (r > 0 && !(st.health === 3 && st.score < 30 && st.time < 2 && st.combo === 0 && st.seed === 5)) restartOk = false;
      let health = 3, lastHitT = -9;
      const out = await drive(page, {
        ms: 90000, mode: 'seek', want: want.size ? want : new Set(['pothole', 'boda', 'askari']), steer: keySteer(page),
        onTick: async (s, newEv) => {
          for (const x of newEv) {
            if (x.type === 'repair') health = x.health;
            if (x.type !== 'hit') continue;
            allHits.push(x); want.delete(x.kind);
            if (!validHitGeometry(x)) badGeom++;
            if (x.health !== health - 1) badHealth++;
            if (x.t - lastHitT < 1.5) badGrace++;
            health = x.health; lastHitT = x.t;
          }
        }
      });
      const s = out.s, over = out.evs.find((x) => x.type === 'gameover');
      runs.push({ run: r + 1, score: s.score, simSeconds: s.time, hits: s.stats.hits, mode: s.mode });
      if (s.mode !== 'gameover' || !over) { overUiOk = false; break; }
      await page.waitForSelector('#over:not([hidden])', { timeout: 3000 });
      const ui = await page.evaluate(() => ({ score: document.getElementById('oScore').textContent, best: document.getElementById('oBest').textContent, nb: !document.getElementById('newBest').hidden, ls: localStorage.getItem('matatuRush.best') }));
      const fmt = (n) => 'KSh ' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      const expBest = Math.max(bestSoFar, s.score);
      if (ui.score !== fmt(s.score) || ui.best !== fmt(expBest)) overUiOk = false;
      if (s.best !== expBest || Number(ui.ls || 0) !== expBest || ui.nb !== (s.score > bestSoFar)) bestOk = false;
      bestSoFar = expBest;
      if (!shotOver) { shotOver = true; await sleep(250); overFonts = await fontAudit(page); await page.screenshot({ path: path.join(SHOTS, '05-gameover-desktop.png') }); }
    }
    notes.collisions = { runs, hits: allHits.map((x) => ({ kind: x.kind, px: x.px, entX: x.entX, d: x.d, health: x.health, fine: x.fine })) };
    const kinds = new Set(allHits.map((x) => x.kind));
    check('collision', 'drove into a pothole, a boda boda and an askari checkpoint with real keys', kinds.has('pothole') && kinds.has('boda') && kinds.has('askari'), Array.from(kinds));
    check('collision', 'each hit costs exactly one heart', badHealth === 0 && allHits.length >= 3, { hits: allHits.length });
    check('fairness', 'every hit had real hitbox overlap (lateral and longitudinal)', badGeom === 0, { checked: allHits.length });
    check('fairness', 'post-hit grace: no two hits within 1.5 s', badGrace === 0);
    const ask = allHits.filter((x) => x.kind === 'askari');
    check('collision', 'askari checkpoint also charges a fine (max KSh 100)', ask.length > 0 && ask.every((x) => x.fine >= 0 && x.fine <= 100) && ask.some((x) => x.fine > 0), ask.map((x) => x.fine));
    check('gameover', 'health reaching zero ends the run and shows the game over screen with the right numbers', overUiOk && runs.length >= 2, runs);
    check('text', 'game over screen: every visible text is at least 14 px', !!overFonts && overFonts.n > 8 && overFonts.bad.length === 0, overFonts && { nodes: overFonts.n, min: overFonts.min, bad: overFonts.bad });
    check('restart', 'Enter and R restart a clean run (3 hearts, zero score, same fixed seed)', restartOk && runs.length >= 2);
    check('persist', 'best score is the max across runs, flagged as new best only when beaten, written to localStorage', bestOk && bestSoFar > 0, { best: bestSoFar });
    await page.reload();
    await page.waitForFunction(() => !!window.MatatuRush);
    const s2 = await snap(page);
    const tb = await page.textContent('#titleBest');
    check('persist', 'best score survives a page reload and shows on the title', s2.best === bestSoFar && tb.replace(/[^0-9]/g, '') === String(bestSoFar), tb);
    await page.evaluate(() => localStorage.setItem('matatuRush.best', 'not-a-number'));
    await page.reload();
    await page.waitForFunction(() => !!window.MatatuRush);
    check('storage', 'corrupt stored best is ignored safely', (await snap(page)).best === 0);
    await ctx.close();
  }

  /* ===== 4b. Top 5 board: name entry, keyboard safety, persistence, sheet layout ===== */
  console.log('\n4b. Top 5 board (data checks in Node, then the real screens in the browser)');
  boardNodeChecks();
  console.log('\n4c. OVERLAP power: simulation checks in Node');
  overlapNodeChecks();
  {
    const G = 'board', KEY = 'matatuRush.top5';
    const ALIAS = /^(Dere|Konda|Makanga|Rubani) [1-9]\d\d$/;
    const ctx = await browser.newContext(desktop);
    const page = await ctx.newPage(); watch(page, 'board');
    let dialogs = 0;
    page.on('dialog', (d) => { dialogs++; d.dismiss().catch(() => {}); });
    const seedBoard = async (list) => {
      await page.evaluate(([k, v]) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }, [KEY, list === null ? null : JSON.stringify(list)]);
      await page.reload();
      await page.waitForFunction(() => !!window.MatatuRush);
    };
    const fivePlus = (score) => [1, 2, 3, 4, 5].map((n) => ({ name: 'Seed ' + n, score: score - n, id: 'seed' + n }));
    const toOver = async () => {
      await page.keyboard.press('Enter');
      await waitFor(page, (x) => x.mode === 'running', 3000, 'board run');
      const out = await drive(page, { ms: 90000, mode: 'seek', want: new Set(['pothole', 'boda', 'askari']), steer: keySteer(page) });
      await page.waitForSelector('#over:not([hidden])', { timeout: 5000 });
      await sleep(80);
      return out;
    };
    const overUi = () => page.evaluate(() => {
      const f = document.getElementById('nameForm'), act = document.activeElement;
      return {
        form: !f.hidden, focus: act ? act.id : '', saved: document.getElementById('nameSaved').hidden ? '' : document.getElementById('nameSaved').textContent,
        rows: Array.from(document.querySelectorAll('#overBoard li')).map((li) => li.textContent), cur: Array.from(document.querySelectorAll('#overBoard li[aria-current="true"]')).map((li) => li.querySelector('.nm').textContent),
        rankLine: document.getElementById('nameRank').textContent, placeholder: document.getElementById('nameInput').placeholder, overShown: !document.getElementById('over').hidden
      };
    });
    const stored = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]'), KEY);

    await page.goto(URL + '?seed=5');
    await page.waitForFunction(() => !!window.MatatuRush);
    await seedBoard(null);

    /* --- run 1: empty board, so the run qualifies. Keyboard safety, Save by Enter, reload, title sheet --- */
    await toOver();
    let s = await snap(page), u = await overUi();
    check(G, 'qualifying run: name form shown with the Top 5 line, input focused, an alias entry is already on the board and in storage',
      u.form && u.focus === 'nameInput' && s.boardRank >= 1 && s.board.length >= 1 && ALIAS.test(s.board[s.boardRank - 1].name) && s.board[s.boardRank - 1].score === s.score && /^You made the Top 5! Rank #1$/.test(u.rankLine) && u.placeholder === s.board[0].name && (await stored()).length === s.board.length, { rank: s.boardRank, board: s.board, focus: u.focus, line: u.rankLine });
    check(G, 'game over list highlights this run with aria-current and the alias', u.cur.length === 1 && u.cur[0] === s.board[0].name && u.rows.length === 1, u);
    const mutedBefore = s.audio.muted;
    await page.keyboard.type('  m r m r  ');
    await sleep(120);
    s = await snap(page);
    const typed = await page.inputValue('#nameInput');
    check(G, 'typing m, r and spaces in the name box does not mute, restart or leave the game over screen', typed === '  m r m r  ' && s.audio.muted === mutedBefore && s.mode === 'gameover' && s.screen === 'over' && (await page.isVisible('#nameForm')), { typed, muted: s.audio.muted, mode: s.mode, screen: s.screen });
    /* hold Enter: the first keydown submits; the repeats that follow land on Play again and must not restart */
    await page.keyboard.down('Enter');
    await sleep(150);
    s = await snap(page); u = await overUi();
    const st = await stored();
    check(G, 'Enter in the box saves (not restart): name stored trimmed and at most 12 chars, form gone, confirmation shown, focus on Play again, listed in the board',
      s.screen === 'over' && s.mode === 'gameover' && !u.form && u.saved === 'Saved as m r m r' && u.focus === 'btnAgain' && st[0].name === 'm r m r' && st[0].name.length <= 12 && u.rows.length === 1 && /m r m r/.test(u.rows[0]) && /KSh/.test(u.rows[0]) && u.cur[0] === 'm r m r', { u, st });
    check(G, 'confirmation is announced in the live region', /Saved as m r m r/.test(await page.textContent('#live')));
    await sleep(750);
    for (let i = 0; i < 4; i++) { await page.keyboard.down('Enter'); await sleep(150); }
    const heldMid = await snap(page);
    await page.keyboard.up('Enter');
    await sleep(150);
    s = await snap(page); u = await overUi();
    check(G, 'holding Enter after saving (auto-repeat keydowns well past the 600 ms guard) does not restart the game', heldMid.screen === 'over' && heldMid.mode === 'gameover' && s.screen === 'over' && s.mode === 'gameover' && u.focus === 'btnAgain' && s.tick === heldMid.tick, { mid: heldMid.screen, end: s.screen, mode: s.mode });
    await page.reload();
    await page.waitForFunction(() => !!window.MatatuRush);
    await page.click('#btnBoard');
    await sleep(120);
    const sheet = await page.evaluate(() => ({ open: !document.getElementById('board').hidden, focus: document.activeElement && document.activeElement.id, rows: Array.from(document.querySelectorAll('#boardList li')).map((li) => li.textContent), empty: !document.getElementById('boardEmpty').hidden, role: document.getElementById('board').getAttribute('role'), modal: document.getElementById('board').getAttribute('aria-modal') }));
    check(G, 'saved name survives a page reload and shows in the title Top 5 sheet (role dialog, aria-modal, focus on Close)', sheet.open && sheet.rows.length === 1 && /m r m r/.test(sheet.rows[0]) && !sheet.empty && sheet.focus === 'btnBoardClose' && sheet.role === 'dialog' && sheet.modal === 'true', sheet);
    await page.keyboard.press('Escape');
    await sleep(100);
    const closed = await page.evaluate(() => ({ hidden: document.getElementById('board').hidden, focus: document.activeElement && document.activeElement.id }));
    s = await snap(page);
    check(G, 'Escape closes the sheet, stays on the title and returns focus to the Top 5 button', closed.hidden && closed.focus === 'btnBoard' && s.screen === 'title', closed);

    /* --- run 2 (320x568): Escape in the input is Skip; alias kept, stays on the over screen --- */
    await page.setViewportSize({ width: 320, height: 568 });
    await seedBoard([{ name: 'Old', score: 1, id: 'old1' }]);
    await fontsReady(page);
    await toOver();
    s = await snap(page); u = await overUi();
    const aliasBefore = s.board[0].name;
    const lay = await page.evaluate(() => { const r = document.querySelector('#over .panel').getBoundingClientRect(); const i = document.getElementById('nameInput'); return { panelW: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), sideways: document.documentElement.scrollWidth > innerWidth, inputFont: parseFloat(getComputedStyle(i).fontSize), inputH: Math.round(i.getBoundingClientRect().height) }; });
    const of = await fontAudit(page);
    check(G, '320x568 game over with the form: no sideways scroll, input font at least 16 px, every visible text at least 14 px', u.form && !lay.sideways && lay.inputFont >= 16 && lay.left >= 0 && lay.right <= 320 && of.bad.length === 0, { lay, bad: of.bad });
    await sleep(200);
    await page.screenshot({ path: path.join(SHOTS, '13-gameover-top5-320x568.png') });
    await page.keyboard.type('mm');
    await page.keyboard.down('Escape');
    await sleep(120);
    s = await snap(page); u = await overUi();
    check(G, 'Escape in the name box acts like Skip: alias kept, form hidden, still on the game over screen (no jump to the title)', s.screen === 'over' && u.overShown && !u.form && s.board.some((e) => e.name === aliasBefore) && u.saved === 'Saved as ' + aliasBefore && u.focus === 'btnAgain' && (await stored()).some((e) => e.name === aliasBefore), { u, aliasBefore });
    /* keep Escape held: auto-repeat keydowns past the guard must not reach the title */
    await sleep(700);
    for (let i = 0; i < 3; i++) { await page.keyboard.down('Escape'); await sleep(150); }
    await page.keyboard.up('Escape');
    await sleep(100);
    s = await snap(page);
    check(G, 'holding Escape after Skip (repeats past the guard) does not jump to the title', s.screen === 'over' && s.mode === 'gameover', { screen: s.screen, mode: s.mode });
    await page.keyboard.press('Escape');
    await sleep(150);
    check(G, 'a fresh Escape press on the game over screen still goes to the title', (await snap(page)).screen === 'title');
    await page.setViewportSize({ width: 1280, height: 720 });

    /* --- run 3 (844x390): full board of low scores. Skip with a held Enter keeps the alias and Play again is scrolled into view; the board stays at 5, sorted --- */
    await page.setViewportSize({ width: 844, height: 390 });
    await seedBoard([1, 2, 3, 4, 5].map((n) => ({ name: 'Low ' + n, score: 1, id: 'low' + n })));
    await fontsReady(page);
    await toOver();
    await sleep(200);
    s = await snap(page); u = await overUi();
    const alias3 = s.board[s.boardRank - 1] && s.board[s.boardRank - 1].name;
    const inView = (sel) => page.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), vh: innerHeight, vw: innerWidth, ok: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && r.height > 0 }; }, sel);
    const inpView = await inView('#nameInput');
    check(G, '844x390 game over with the form: the focused name input is fully inside the viewport', u.form && u.focus === 'nameInput' && inpView.ok, inpView);
    check(G, 'qualifying run on a full board: form shown, board still exactly 5 and sorted high to low', u.form && s.boardRank === 1 && s.board.length === 5 && s.board.every((e, i) => i === 0 || s.board[i - 1].score >= e.score) && ALIAS.test(alias3), { rank: s.boardRank, scores: s.board.map((e) => e.score) });
    await page.focus('#btnSkipName');
    await page.keyboard.down('Enter');
    await sleep(150);
    s = await snap(page); u = await overUi();
    const againView = await inView('#btnAgain');
    check(G, 'Skip button (by Enter) keeps the alias, hides the form and stays on the game over screen', s.screen === 'over' && !u.form && u.saved === 'Saved as ' + alias3 && u.focus === 'btnAgain' && (await stored()).filter((e) => e.name === alias3).length === 1, { saved: u.saved });
    check(G, '844x390 after Skip: Play again has focus AND sits fully inside the viewport (panel scrolled to it)', u.focus === 'btnAgain' && againView.ok, againView);
    await sleep(750);
    for (let i = 0; i < 4; i++) { await page.keyboard.down('Enter'); await sleep(150); }
    await page.keyboard.up('Enter');
    await sleep(150);
    s = await snap(page);
    check(G, 'holding Enter on Skip (repeats land on Play again) does not restart the game', s.screen === 'over' && s.mode === 'gameover', { screen: s.screen, mode: s.mode });
    await page.setViewportSize({ width: 1280, height: 720 });

    /* --- run 4: hostile name is rendered as text only --- */
    await seedBoard([1, 2, 3, 4, 5].map((n) => ({ name: 'Low ' + n, score: 1, id: 'low' + n })));
    await toOver();
    await page.fill('#nameInput', '<img src=x onerror=alert(1)>');
    await page.click('#btnSaveName');
    await sleep(200);
    const x1 = await page.evaluate(() => ({ imgs: document.querySelectorAll('.board img').length, anyImg: document.querySelectorAll('#over img, #board img').length, names: Array.from(document.querySelectorAll('#overBoard .nm')).map((n) => n.textContent) }));
    await page.reload();
    await page.waitForFunction(() => !!window.MatatuRush);
    await page.click('#btnBoard'); await sleep(120);
    const x2 = await page.evaluate(() => ({ imgs: document.querySelectorAll('.board img').length, names: Array.from(document.querySelectorAll('#boardList .nm')).map((n) => n.textContent) }));
    check(G, 'a name like <img src=x onerror=alert(1)> is cut to 12 chars and shown as text: no img element in any board, no alert fired', x1.imgs === 0 && x1.anyImg === 0 && x1.names.includes('<img src=x o') && x2.imgs === 0 && x2.names.includes('<img src=x o') && dialogs === 0, { x1, x2, dialogs });

    /* --- run 5: board full of high scores, so this run does not qualify --- */
    await seedBoard(fivePlus(999999999));
    const before5 = JSON.stringify(await stored());
    await toOver();
    s = await snap(page); u = await overUi();
    check(G, 'a score below the 5th place shows no form: rank 0, board unchanged, Play again keeps focus', !u.form && s.boardRank === 0 && JSON.stringify(await stored()) === before5 && u.focus === 'btnAgain' && u.cur.length === 0 && u.rows.length === 5, { rank: s.boardRank, focus: u.focus });
    await page.keyboard.press('Enter');
    s = await waitFor(page, (x) => x.mode === 'running', 3000, 'restart after no-form over');
    check(G, 'with no form, Enter on Play again still restarts the run', s.mode === 'running' && s.screen === 'game', { screen: s.screen });
    await ctx.close();
  }
  {
    /* a demo (autopilot) run that really reaches game over must not enter the board, show the form, or highlight a row.
       Seed 121 is the one autopilot seed found (scan of seeds 1 to 300 in Node) that dies inside 60 s of sim (at about 59 s);
       the board is pre-filled with score 1 entries so a wrongly inserted demo score (thousands) would show up. */
    const ctx = await browser.newContext(desktop);
    const page = await ctx.newPage(); watch(page, 'board-demo');
    const seeded = JSON.stringify([1, 2, 3, 4, 5].map((n) => ({ name: 'Low ' + n, score: 1, id: 'low' + n })));
    await page.goto(URL + '?seed=7');
    await page.evaluate((v) => localStorage.setItem('matatuRush.top5', v), seeded);
    await page.goto(URL + '?seed=121&autopilot=1&autostart=1');
    await page.waitForFunction(() => !!window.MatatuRush);
    const sDemo = await waitFor(page, (x) => x.mode === 'gameover', 90000, 'demo game over');
    await page.waitForSelector('#over:not([hidden])', { timeout: 5000 });
    await sleep(100);
    const d = await page.evaluate(() => ({ ls: localStorage.getItem('matatuRush.top5'), form: !document.getElementById('nameForm').hidden, cur: document.querySelectorAll('#overBoard li[aria-current]').length, rows: document.querySelectorAll('#overBoard li').length, tag: document.getElementById('overTag').textContent }));
    check('board', 'a real demo game over (autopilot seed 121, about 59 s of sim): over screen shown, no name form, rank 0, board storage unchanged, no highlighted row',
      sDemo.autopilot === true && sDemo.boardRank === 0 && sDemo.score > 1 && !d.form && d.ls === seeded && d.cur === 0 && d.rows === 5 && /Demo over/.test(d.tag), { rank: sDemo.boardRank, score: sDemo.score, d });
    await ctx.close();
  }
  {
    /* Top 5 sheet fits the small layout sizes, text at least 14 px, nothing clipped */
    /* worst realistic case: twelve wide-ish letters and six-digit fares (KSh 999,999) */
    const names = ['Mwangi Kamau', 'Makanga 999', 'Wanjiru Mwen', 'Konda 100', 'Rubani Omwa'];
    const list = names.map((n, i) => ({ name: n, score: 999999 - i, id: 'fit' + i }));
    const sizes = [[320, 568, true], [844, 390, true], [390, 844, true], [1280, 720, false]];
    for (const [w, h, touch] of sizes) {
      const tag = w + 'x' + h;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 2 : 1 });
      const page = await ctx.newPage(); watch(page, 'board-sheet-' + tag);
      await page.goto(URL + '?seed=7');
      await page.evaluate((v) => localStorage.setItem('matatuRush.top5', v), JSON.stringify(list));
      await page.reload();
      await page.waitForFunction(() => !!window.MatatuRush);
      await fontsReady(page); await sleep(300);
      const btn = await page.evaluate(() => { const r = document.getElementById('btnBoard').getBoundingClientRect(); return { inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, h: r.height, scroll: document.getElementById('title').scrollTop }; });
      await page.click('#btnBoard'); await sleep(200);
      const fit = await page.evaluate(() => {
        const root = document.getElementById('board'), items = Array.from(root.querySelectorAll('.board li, .board .nm, .board .sc, #btnBoardClose, .h2'));
        const rect = items.map((el) => { const r = el.getBoundingClientRect(); return { in: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5 && r.width > 0, clipped: el.scrollWidth > el.clientWidth + 1 }; });
        return { n: rect.length, allIn: rect.every((i) => i.in), noneClipped: rect.every((i) => !i.clipped), scrolls: root.scrollHeight > root.clientHeight + 1, sideways: document.documentElement.scrollWidth > innerWidth, rows: root.querySelectorAll('.board li').length };
      });
      const tf = await fontAudit(page);
      check('board', tag + ' title: the Top 5 button is on screen without scrolling and at least 44 px tall', btn.inView && btn.scroll === 0 && btn.h >= 44, btn);
      check('board', tag + ' Top 5 sheet: five rows, Close and heading fully on screen, nothing clipped, no scrolling', fit.rows === 5 && fit.allIn && fit.noneClipped && !fit.scrolls && !fit.sideways, fit);
      check('text', tag + ' Top 5 sheet: every visible text is at least 14 px', tf.n > 8 && tf.bad.length === 0, { nodes: tf.n, min: tf.min, bad: tf.bad });
      if (w === 320 || w === 1280) await page.screenshot({ path: path.join(SHOTS, (w === 320 ? '14' : '15') + '-top5-sheet-' + tag + '.png') });
      await page.keyboard.press('Escape');
      await ctx.close();
    }
  }

  /* ===== 5. Touch on a phone viewport ===== */
  console.log('\n5. Touch controls on a 390x844 phone viewport');
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage(); watch(page, 'phone');
    await page.goto(URL + '?seed=7');
    await page.waitForFunction(() => !!window.MatatuRush);
    await fontsReady(page);
    await sleep(500);
    const fit = await page.evaluate(() => {
      const r = document.getElementById('btnStart').getBoundingClientRect();
      const p = document.querySelector('#title .panel').getBoundingClientRect();
      return { startVisible: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, panelBottom: Math.round(p.bottom), vh: innerHeight, sw: document.documentElement.scrollWidth, vw: innerWidth };
    });
    check('phone', 'title fits the phone: start button on screen, no sideways scroll', fit.startVisible && fit.sw <= fit.vw && fit.panelBottom <= fit.vh, fit);
    await page.screenshot({ path: path.join(SHOTS, '06-title-phone.png') });
    const centre = async (sel) => { const b = await page.locator(sel).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
    const tap = async (sel) => { const [x, y] = await centre(sel); await page.touchscreen.tap(x, y); await sleep(70); };
    await tap('#btnStart');
    let s = await waitFor(page, (x) => x.mode === 'running', 2000, 'running');
    check('touch', 'tapping TWENDE starts the run and unlocks audio', s.mode === 'running' && s.audio.created && s.audio.state === 'running', s.audio);
    const seq = [];
    await tap('#btnRight'); s = await snap(page); seq.push(s.player.lane);
    await tap('#btnLeft'); s = await snap(page); seq.push(s.player.lane);
    await page.touchscreen.tap(60, 380); await sleep(70); s = await snap(page); seq.push(s.player.lane);
    await page.touchscreen.tap(330, 380); await sleep(70); s = await snap(page); seq.push(s.player.lane);
    const ev = (await read(page, 0)).e;
    const le = ev.filter((x) => x.type === 'lane');
    check('touch', 'on-screen buttons and tapping the road sides change lanes', seq.join(',') === '2,1,0,1', seq.join(','));
    check('touch', 'those lane changes are logged with source touch', le.length === 4 && le.every((x) => x.source === 'touch') && s.inputs.touch === 4 && s.inputs.keyboard === 0, s.inputs);
    const lay = await page.evaluate(() => {
      const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), in: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }; };
      const fs = (id) => parseFloat(getComputedStyle(document.getElementById(id)).fontSize);
      return { left: box('btnLeft'), right: box('btnRight'), horn: box('btnHorn'), pause: box('btnPause'), mute: box('btnMuteHud'), score: box('score'), hearts: box('hearts'), zone: box('zone'), scoreFont: fs('score'), sw: document.documentElement.scrollWidth, vw: innerWidth };
    });
    const big = (b) => b.in && b.w >= 44 && b.h >= 44;
    check('phone', 'touch targets are on screen and at least 44 px', big(lay.left) && big(lay.right) && big(lay.horn) && big(lay.pause) && big(lay.mute), { left: lay.left, horn: lay.horn, right: lay.right, pause: lay.pause });
    check('phone', 'HUD is on screen and legible (score font >= 24 px, no overflow)', lay.score.in && lay.hearts.in && lay.zone.in && lay.scoreFont >= 24 && lay.sw <= lay.vw, { scoreFont: lay.scoreFont, score: lay.score, zone: lay.zone });
    check('phone', 'matatu is drawn above the control bar', s.view.playerY + s.view.unit * 0.75 < 844 - 12 - 76 + 4, s.view);
    const [lx, ly] = await centre('#btnLeft'), [rx, ry] = await centre('#btnRight');
    let hornTapped = false, shot = false;
    const run = await drive(page, {
      ms: 12000, mode: 'play', since: ev.length ? ev[ev.length - 1].i : 0,
      steer: (dir) => page.touchscreen.tap(dir < 0 ? lx : rx, dir < 0 ? ly : ry),
      onTick: async (q, newEv) => {
        if (!hornTapped && q.time > 6 && q.horn.ready) { hornTapped = true; await tap('#btnHorn'); }
        if (!shot && q.time > 3 && newEv.some((x) => x.type === 'pickup')) { shot = true; await sleep(80); await page.screenshot({ path: path.join(SHOTS, '07-gameplay-phone.png') }); }
      }
    });
    if (!shot) await page.screenshot({ path: path.join(SHOTS, '07-gameplay-phone.png') });
    const hornEv = run.evs.find((x) => x.type === 'horn');
    const pk = run.evs.filter((x) => x.type === 'pickup');
    notes.phone = { simSeconds: run.s.time, pickups: run.s.stats.pickups, touchInputs: run.s.inputs.touch, hits: run.s.stats.hits };
    check('touch', 'tapping HORN fires nitro (source touch)', !!hornEv && hornEv.source === 'touch', hornEv);
    check('touch', 'touch-only play collects fares', run.s.stats.pickups >= 2 && run.s.inputs.keyboard === 0 && run.s.inputs.autopilot === 0, { pickups: run.s.stats.pickups, inputs: run.s.inputs, viaTouchRun: pk.length });
    if (run.s.mode === 'running') {
      await tap('#btnPause');
      const p = await waitFor(page, (x) => x.mode === 'paused', 1500, 'paused');
      await tap('#btnResume');
      const q = await waitFor(page, (x) => x.mode === 'running', 1500, 'resumed');
      check('touch', 'pause and resume buttons work by touch', p.mode === 'paused' && q.mode === 'running');
    } else check('touch', 'pause by touch (run ended early)', false, run.s.mode);
    await page.setViewportSize({ width: 844, height: 390 });
    await sleep(500);
    const land = await snap(page);
    check('phone', 'rotating to landscape re-lays out without errors', land.view.w === 844 && land.view.h === 390 && land.view.unit > 20, land.view);
    await ctx.close();
  }

  /* ===== 5b. Short screens: Start without scrolling, banner out of the road ===== */
  console.log('\n5b. Short screens (320x568, 360x640, 844x390) and banner placement');
  await smallScreenChecks(browser);

  /* ===== 5d. Round 3 layout: text sizes, how-to sheet, pause/mute placement, shop strip ===== */
  console.log('\n5d. Layout at 320x568, 844x390, 390x844 and 1280x720');
  await layoutChecks(browser);

  /* ===== 5e. OVERLAP: keys, taps, button states, the matatu on the shoulder ===== */
  console.log('\n5e. OVERLAP power in the browser (real keys and taps)');
  await overlapBrowserChecks(browser);

  /* ===== 5c. Near-miss and repair with real keys ===== */
  console.log('\n5c. Near-miss bonus and fundi repair, driven by real keys');
  {
    const o = await nearMissAndRepair(browser, NM_SEED);
    notes.nearMissRepair = o;
    check('nearmiss', 'a last moment swerve past a hazard emits nearMiss, with no hit on that hazard', !!o.near && !o.nearHit && o.near.playerLane !== o.near.lane, o.near);
    check('nearmiss', 'near-miss pays its bonus (score rose by at least 25 across the event)', !!o.near && o.nearScore.before !== null && o.nearScore.after - o.nearScore.before >= 25 && o.nearScore.stat >= 1, o.nearScore);
    check('repair', 'driving into the fundi spanner emits repair and restores exactly one heart (max 3)', !!o.repair && !!o.before && o.before.health < 3 && o.after.health === o.before.health + 1 && o.repair.health === o.after.health, { before: o.before, after: o.after });
    check('repair', 'repair needed the matatu in that lane and pays KSh 25', !!o.repair && !!o.before && Math.abs(o.before.px - o.repair.lane) < 0.75 && o.after.score - o.before.score >= 25, o.repair);
    check('banner', 'every banner seen during that 1280x720 play sat in the kerb gutter, never over the road', o.bannerSeen > 0 && o.bannerBad === 0, { samples: o.bannerSeen, overlapping: o.bannerBad });
  }

  /* ===== 6. localStorage unavailable ===== */
  console.log('\n6. localStorage blocked (private mode style failure)');
  {
    const ctx = await browser.newContext(desktop);
    await ctx.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });
    });
    const page = await ctx.newPage(); watch(page, 'nostorage');
    await page.goto(URL + '?seed=5');
    await page.waitForFunction(() => !!window.MatatuRush);
    let s = await snap(page);
    check('storage', 'game boots with localStorage throwing', s.mode === 'title' && s.storageOk === false, { storageOk: s.storageOk });
    await page.keyboard.press('Enter');
    await waitFor(page, (x) => x.mode === 'running', 2000, 'running');
    await page.keyboard.press('m'); await sleep(100); await page.keyboard.press('m');
    const out = await drive(page, { ms: 60000, mode: 'seek', want: new Set(['pothole', 'boda', 'askari']), steer: keySteer(page) });
    await page.waitForSelector('#over:not([hidden])', { timeout: 3000 });
    s = await snap(page);
    check('storage', 'full run to game over works, best kept in memory', out.s.mode === 'gameover' && s.best === out.s.score && s.best > 0, { best: s.best });
    await sleep(700); await skipNameIfShown(page); await page.keyboard.press('Enter');
    s = await waitFor(page, (x) => x.mode === 'running', 2000, 'restart');
    check('storage', 'restart works without storage', s.health === 3 && s.best > 0);
    await ctx.close();
  }

  /* ===== 7. Autopilot demo: determinism, no audio without gesture, video ===== */
  console.log('\n7. Seeded autopilot demo: determinism and recording');
  {
    const MAXTICK = 2280; /* 19 s of simulation at 120 Hz */
    const FRAMES = path.join(OUT, 'video-tmp');
    const grab = async (video) => {
      const ctx = await browser.newContext(desktop);
      const page = await ctx.newPage(); watch(page, 'demo');
      const frames = [];
      let cdp = null;
      if (video) {
        /* CDP screencast -> JPEG frames -> system ffmpeg (Playwright's own ffmpeg build is not installed here) */
        fs.rmSync(FRAMES, { recursive: true, force: true }); fs.mkdirSync(FRAMES, { recursive: true });
        try {
          cdp = await ctx.newCDPSession(page);
          cdp.on('Page.screencastFrame', (f) => {
            const file = path.join(FRAMES, 'f' + String(frames.length).padStart(5, '0') + '.jpg');
            fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
            frames.push({ file, ts: f.metadata.timestamp });
            cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
          });
        } catch (e) { cdp = null; }
      }
      await page.goto(URL + '?seed=42&autopilot=1&autostart=1');
      await page.bringToFront();
      await page.waitForFunction(() => !!window.MatatuRush);
      if (cdp) await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: 1280, maxHeight: 720, everyNthFrame: 2 });
      const s = await waitFor(page, (x) => x.tick >= MAXTICK + 60 || x.mode === 'gameover', 40000, 'demo ticks');
      const ev = (await read(page, 0)).e.filter((x) => x.tick <= MAXTICK);
      if (cdp) { await sleep(1500); await cdp.send('Page.stopScreencast').catch(() => {}); }
      await ctx.close();
      return { s, ev, frames };
    };
    const A = await grab(false), B = await grab(false);
    const node = nodeReplay(42, MAXTICK);
    const ja = JSON.stringify(A.ev), jb = JSON.stringify(B.ev), jn = JSON.stringify(node);
    notes.demo = { events: A.ev.length, pickups: A.ev.filter((x) => x.type === 'pickup').length, hits: A.ev.filter((x) => x.type === 'hit').length };
    check('demo', 'autopilot plays through the same input path (source autopilot) and scores', A.s.inputs.autopilot > 5 && A.s.autopilot === true && A.ev.filter((x) => x.type === 'pickup').length >= 3, A.s.inputs);
    check('audio', 'autostarted demo with no gesture never creates an AudioContext', A.s.audio.created === false && B.s.audio.created === false, A.s.audio);
    check('determinism', 'same seed gives an identical event log in two browser runs', A.ev.length > 10 && ja === jb, { events: A.ev.length });
    check('determinism', 'browser event log equals a pure Node replay of js/game.js (events are real simulation output)', ja === jn, { browser: A.ev.length, node: node.length });

    /* ----- 7b. Seed 4 demo started by a REAL click on "Watch demo": popups, audio, recording ----- */
    console.log('\n7b. Seed 4 demo after a real click: popup overlap audit, audio-on recording');
    const ctx = await browser.newContext(desktop);
    await ctx.addInitScript(AUDIO_TAP);
    const page = await ctx.newPage(); watch(page, 'demo-audio');
    const frames = [];
    let cdp = null;
    /* CDP screencast -> JPEG frames -> system ffmpeg (Playwright's own ffmpeg build is not installed here) */
    fs.rmSync(FRAMES, { recursive: true, force: true }); fs.mkdirSync(FRAMES, { recursive: true });
    try {
      cdp = await ctx.newCDPSession(page);
      cdp.on('Page.screencastFrame', (f) => {
        const file = path.join(FRAMES, 'f' + String(frames.length).padStart(5, '0') + '.jpg');
        fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
        frames.push({ file, ts: f.metadata.timestamp });
        cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      });
    } catch (e) { cdp = null; }
    await page.goto(URL + '?seed=4');
    await page.waitForFunction(() => !!window.MatatuRush);
    await fontsReady(page); await sleep(300);
    const pre = await snap(page);
    const preRec = await page.evaluate(() => ({ hasRecorder: !!window.__rec.mr, chunks: window.__rec.chunks.length }));
    if (cdp) await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: 1280, maxHeight: 720, everyNthFrame: 2 });
    await sleep(250);
    await page.click('#btnDemo');
    const first = await waitFor(page, (x) => x.mode === 'running', 3000, 'demo click');
    const pa = mkPopupAudit();
    let since = 0, peak = 0, shotPop = false, demoFonts = null, last = first;
    const dEv = [], states = new Set();
    const tEnd = Date.now() + 40000;
    while (Date.now() < tEnd) {
      const r = await read(page, since); last = r.s;
      for (const x of r.e) { dEv.push(x); since = x.i; }
      peak = Math.max(peak, last.audio.level); states.add(last.audio.state);
      const seen = popupAudit(last, pa);
      if (!demoFonts && last.time > 1) demoFonts = await fontAudit(page);
      if (!shotPop && seen && seen.horn && seen.fare && seen.beba) { shotPop = true; await page.screenshot({ path: path.join(SHOTS, '12-popups-fare-combo-hornready-desktop.png') }); }
      if (last.mode !== 'running' || last.time >= 21.2) break;
      await sleep(20);
    }
    const aud = await page.evaluate(() => window.__rec.stop());
    if (cdp) { await sleep(400); await cdp.send('Page.stopScreencast').catch(() => {}); }
    await ctx.close();
    const dp = dEv.filter((x) => x.type === 'pickup'), fired = last.audio.fired || {};
    notes.demoAudio = { seed: 4, simSeconds: last.time, pickups: dp.length, hornReadyEvents: dEv.filter((x) => x.type === 'hornReady').length, audioState: last.audio.state, statesSeen: Array.from(states), sequencerSteps: last.audio.steps, peakRms: peak, sfxFired: fired,
      popups: { frames: pa.frames, maxFloats: pa.maxFloats, comboAndFareFrames: pa.both, hornReadyWithPickupFrames: pa.hornWithPickup, slotFrames: pa.slotSeen, slotCopy: pa.copy } };
    console.log('  AUDIO  demo AudioContext state: ' + last.audio.state + ', sequencer steps: ' + last.audio.steps + ', peak RMS: ' + peak + ', sfx fired: ' + JSON.stringify(fired));
    check('audio', 'recording page: no AudioContext and no recorder before the click; the click on Watch demo starts audio (running, music on)', pre.audio.created === false && !preRec.hasRecorder && preRec.chunks === 0 && first.audio.created && first.audio.state === 'running' && first.audio.musicOn, { before: pre.audio.state, after: first.audio.state });
    check('audio', 'demo: output is audible and sfx come from real events (one pickup sfx per pickup, horn ready chime per hornReady)', peak > 0.01 && states.size === 1 && fired.pickup === dp.length && dp.length >= 5 && (fired.ready || 0) === dEv.filter((x) => x.type === 'hornReady').length && (fired.horn || 0) === dEv.filter((x) => x.type === 'horn').length, { peakRms: peak, fired, pickups: dp.length });
    check('popup', 'seed 4 demo: no two live floating popups (or the horn slot) overlap in any sampled frame', pa.frames > 50 && pa.overlaps.length === 0 && pa.floatOffRoad === 0, { frames: pa.frames, maxFloats: pa.maxFloats, overlaps: pa.overlaps });
    check('popup', 'seed 4 demo: combo (BEBA) and fare popups were visible in the same frame', pa.both > 0, { frames: pa.both });
    check('popup', 'seed 4 demo: HORN READY was visible at the same time as pickup text', pa.hornWithPickup > 0 && shotPop, { frames: pa.hornWithPickup });
    check('popup', 'seed 4 demo: HORN READY sits in its dedicated gutter slot: off the road, clear of the matatu sprite, never in the float stack', pa.slotSeen > 0 && pa.slotBad.length === 0 && pa.hornInFloat === 0 && Object.keys(pa.copy).every((k) => /^HORN (READY!?|CHARGING)$/.test(k)), { slotFrames: pa.slotSeen, copy: pa.copy, bad: pa.slotBad });
    check('text', 'demo HUD (short demo tag included): every visible text is at least 14 px', !!demoFonts && demoFonts.bad.length === 0, demoFonts && { nodes: demoFonts.n, min: demoFonts.min, bad: demoFonts.bad });

    let videoNote = 'not recorded', audioNote = 'no audio captured';
    if (frames.length > 30) {
      try {
        let list = 'ffconcat version 1.0\n';
        for (let i = 0; i < frames.length; i++) {
          const dur = i + 1 < frames.length ? Math.max(0.005, frames[i + 1].ts - frames[i].ts) : 0.04;
          list += 'file ' + path.basename(frames[i].file) + '\nduration ' + dur.toFixed(4) + '\n';
        }
        fs.writeFileSync(path.join(FRAMES, 'list.txt'), list);
        const mp4 = path.join(OUT, 'gameplay-demo.mp4');
        const args = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(FRAMES, 'list.txt')];
        let hasAudio = false;
        if (aud && aud.b64 && aud.startedAt) {
          const webm = path.join(FRAMES, 'audio.webm');
          fs.writeFileSync(webm, Buffer.from(aud.b64, 'base64'));
          /* line the sound up with the picture: both clocks are wall-clock seconds */
          const off = aud.startedAt - frames[0].ts;
          args.push('-itsoffset', off.toFixed(3), '-i', webm, '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '160k');
          hasAudio = true;
          audioNote = 'WebAudio destination recorded with MediaRecorder (opus, ' + Math.round(fs.statSync(webm).size / 1024) + ' KB), offset ' + off.toFixed(2) + ' s';
        } else audioNote = 'audio capture failed: ' + (aud && aud.error);
        args.push('-vf', 'fps=30,scale=1280:720', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-movflags', '+faststart', mp4);
        execFileSync('ffmpeg', args);
        const secs = frames[frames.length - 1].ts - frames[0].ts;
        videoNote = 'out/gameplay-demo.mp4 (' + frames.length + ' frames, ' + secs.toFixed(1) + ' s, ' + Math.round(fs.statSync(mp4).size / 1024) + ' KB, ' + (hasAudio ? 'with audio' : 'silent') + ')';
        if (hasAudio) {
          /* prove the muxed file really carries sound: stream present and not digital silence */
          const { spawnSync } = require('child_process');
          const probe = spawnSync('ffmpeg', ['-hide_banner', '-i', mp4, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
          const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(probe.stderr || ''), max = /max_volume:\s*(-?[\d.]+) dB/.exec(probe.stderr || '');
          notes.videoAudio = { note: audioNote, meanDb: mean ? +mean[1] : null, maxDb: max ? +max[1] : null };
          check('audio', 'out/gameplay-demo.mp4 has a muxed audio stream that is not silent (ffmpeg volumedetect)', !!mean && +mean[1] > -50 && !!max && +max[1] > -30, notes.videoAudio);
        } else check('audio', 'audio-on capture muxed into the recording', false, audioNote);
      } catch (e) { videoNote = 'encode failed: ' + String(e.message).slice(0, 200); }
    }
    fs.rmSync(FRAMES, { recursive: true, force: true });
    notes.video = videoNote;
    check('demo', 'gameplay recording saved', /gameplay-demo\.mp4/.test(videoNote), videoNote);
  }

  /* ===== 7c. Online: the shared Top 5 board (mocked network, local http server) ===== */
  console.log('\n7c. Online shared board: Node checks, then real pages on a local http server with all three Firebase hosts mocked');
  onlineNodeChecks();
  onlineSimChecks();
  await onlineBrowserChecks(browser, desktop);

  /* ===== 8. Contact sheet ===== */
  {
    const shots = fs.readdirSync(SHOTS).filter((f) => /^\d\d-.*\.png$/.test(f)).sort();
    const html = '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#07070f;color:#fff;font:600 15px system-ui,sans-serif;padding:18px}h1{font-size:22px;margin:0 0 14px}div{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}figure{margin:0}img{height:340px;display:block;border:1px solid #444}figcaption{padding:5px 0;color:#b6ff3c}</style><h1>Matatu Rush: test screenshots</h1><div>' +
      shots.map((f) => '<figure><img src="screenshots/' + f + '"><figcaption>' + f + '</figcaption></figure>').join('') + '</div>';
    const tmp = path.join(OUT, 'contact-sheet.html');
    fs.writeFileSync(tmp, html);
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
    const page = await ctx.newPage();
    await page.goto('file://' + tmp);
    await page.waitForLoadState('load');
    await page.screenshot({ path: path.join(OUT, 'contact-sheet.png'), fullPage: true });
    await ctx.close();
    fs.rmSync(tmp);
    const need = ['01-title-desktop.png', '02-gameplay-desktop.png', '03-pickup-combo-desktop.png', '05-gameover-desktop.png', '07-gameplay-phone.png'];
    check('shots', 'required screenshots and contact sheet exist', need.every((f) => shots.includes(f)) && fs.existsSync(path.join(OUT, 'contact-sheet.png')), shots);
  }

  await browser.close();

  /* ===== console report ===== */
  const clean = problems.consoleErrors.length === 0 && problems.pageErrors.length === 0 && problems.failedRequests.length === 0;
  check('console', 'no console errors, uncaught exceptions or failed requests in any page', clean, { consoleErrors: problems.consoleErrors.length, pageErrors: problems.pageErrors.length, failedRequests: problems.failedRequests.length, warnings: problems.consoleWarnings.length });
  check('offline', 'every request made by every page was file:// (no network)', problems.nonFileRequests.length === 0 && requestsSeen > 0, { requests: requestsSeen, nonFile: problems.nonFileRequests.length });
  fs.writeFileSync(path.join(OUT, 'console-errors.json'), JSON.stringify(Object.assign({ generated: new Date().toISOString(), pagesWatched, requestsSeen }, problems), null, 2));

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, 'test-report.json'), JSON.stringify({
    generated: new Date().toISOString(), browser: browserName, url: URL,
    passed: results.length - failed.length, failed: failed.length, total: results.length, notes, results
  }, null, 2));
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed. Reports: out/test-report.json, out/console-errors.json');
  if (failed.length) { console.log('FAILED:\n' + failed.map((f) => ' - [' + f.group + '] ' + f.name + ' ' + f.detail).join('\n')); process.exit(1); }
})().catch((e) => { console.error('TEST RUN CRASHED:', e); process.exit(3); });

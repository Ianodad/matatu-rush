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
/* captured from the UNMODIFIED simulation (before OVERLAP existed): autopilot, 120 s of sim time or game over */
const AUTOPILOT_BASELINE = {
  7: { rows: { 1200: [806, 56.1088, 3, 1, 1, 5, 5], 6000: [7877, 352.0523, 3, 2, 2.925, 25, 12], 12000: [23263, 863.0856, 3, 1, 1, 52, 39] }, final: [14400, 26107, 1107.1704749184764, 3, 'running'], events: 214, md5: '8d6925f2976ab0a7dbe04994fe95629e' },
  42: { rows: { 1200: [2366, 66.0215, 3, 2, 2.175, 7, 7], 6000: [13932, 357.8173, 3, 3, 3, 27, 1], 12000: [34269, 884.7808, 3, 1, 1, 64, 38] }, final: [14400, 40169, 1164.6012535547197, 3, 'running'], events: 266, md5: '65ff6024bb9447b7659d22110a4424d4' }
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
  check(G, 'node: the merge grants 0.9 s of invulnerability and an obstacle waiting in the re-entry lane cannot hurt (it is waved through), now or later', invAtEnd >= 0.89 && merge.slice(0, 3).some((e) => e.hit === true) && hitsIn09.length === 0 && hitTotal() === 0 && g.health === healthAtEnd && g.mode === 'running', { invAtEnd, hit: merge.map((e) => !!e.hit), hits: hitsIn09.length });

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
  check(G, tag + ': from OVERLAP to 0.9 s after the merge: no hit, no smash, no near-miss, no pickup, no repair; merge lands in the edge lane on that side', !!end && bad.length === 0 && end.lane === (ov.side < 0 ? 0 : 3) && end.side === ov.side && out.afterState.player.invuln > 0.25, { bad: bad.slice(0, 3), end, invuln: out.afterState && out.afterState.player.invuln });
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
  /* ---- A. real human run on desktop: pick up passengers with the test bot, press the O key ---- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage(); watch(page, 'overlap-desktop');
    await page.goto(URL + '?seed=7');
    await page.waitForFunction(() => !!window.MatatuRush);
    await fontsReady(page); await sleep(300);
    const text = await page.evaluate(() => ({ title: document.getElementById('title').innerText, keys: document.querySelector('#title .keys').innerText }));
    check(G, 'title controls text explains overlap (O or S) next to horn nitro', /overlap/i.test(text.keys) && /\bO\b/.test(text.keys) && /\bS\b/.test(text.keys) && /horn nitro/i.test(text.title), text.keys);
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
    /* not ready: O, S and ArrowDown all reach the game and answer overlapEmpty (nothing else happens) */
    const e0 = (await read(page, 0)).e.length;
    for (const k of ['o', 'S', 'ArrowDown']) { await page.keyboard.press(k); await sleep(60); }
    let r = await read(page, e0);
    const emp = r.e.filter((x) => x.type === 'overlapEmpty');
    check(G, '1280x720: O, S and ArrowDown while charging each give overlapEmpty (source keyboard) and start nothing', emp.length === 3 && emp.every((x) => x.source === 'keyboard' && x.reason === 'charging') && !r.s.overlap.active && r.e.filter((x) => x.type === 'overlap').length === 0, emp.map((x) => x.reason));
    /* typing in a text box never fires it */
    await page.evaluate(() => { const i = document.createElement('input'); i.id = 'tmpType'; i.type = 'text'; document.body.appendChild(i); i.focus(); });
    const e1 = (await read(page, 0)).e.filter((x) => x.type === 'overlapEmpty').length, kb1 = (await snap(page)).inputs.keyboard;
    for (const k of ['o', 'O', 's', 'ArrowDown']) { await page.keyboard.press(k); await sleep(40); }
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
      const out = await watchOverlap(page, () => page.keyboard.press('o'), {
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
      overlapAssertions('1280x720', 'the O key', out, 'keyboard');
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

if (require.main !== module) { module.exports = { loadPlaywright, smallScreenChecks, nearMissAndRepair, layoutChecks, results, problems }; return; }

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
    const files = ['index.html', 'css/style.css', 'js/core.js', 'js/game.js', 'js/audio.js', 'js/art.js', 'js/render.js', 'js/main.js'];
    const bad = [], net = [], fontUrls = [], impact = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      if (/[\u2014\u2013]/.test(src)) bad.push(f);
      /* the only url() allowed anywhere is a relative link from css/style.css to a bundled .ttf in fonts/ */
      let scan = src;
      if (f === 'css/style.css') {
        scan = src.replace(/url\("\.\.\/fonts\/([A-Za-z0-9-]+\.ttf)"\)/g, (m, name) => { fontUrls.push(name); return 'LOCALFONT'; });
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
    check('static', 'no remote URLs, fetch, XHR, image or media tags in shipped source (only local relative font urls allowed)', net.length === 0, net);
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
       Seed 101 is the one autopilot seed found (scan of seeds 1 to 300 in Node) that dies inside 60 s of sim (at about 53 s);
       the board is pre-filled with score 1 entries so a wrongly inserted demo score (thousands) would show up. */
    const ctx = await browser.newContext(desktop);
    const page = await ctx.newPage(); watch(page, 'board-demo');
    const seeded = JSON.stringify([1, 2, 3, 4, 5].map((n) => ({ name: 'Low ' + n, score: 1, id: 'low' + n })));
    await page.goto(URL + '?seed=7');
    await page.evaluate((v) => localStorage.setItem('matatuRush.top5', v), seeded);
    await page.goto(URL + '?seed=101&autopilot=1&autostart=1');
    await page.waitForFunction(() => !!window.MatatuRush);
    const sDemo = await waitFor(page, (x) => x.mode === 'gameover', 90000, 'demo game over');
    await page.waitForSelector('#over:not([hidden])', { timeout: 5000 });
    await sleep(100);
    const d = await page.evaluate(() => ({ ls: localStorage.getItem('matatuRush.top5'), form: !document.getElementById('nameForm').hidden, cur: document.querySelectorAll('#overBoard li[aria-current]').length, rows: document.querySelectorAll('#overBoard li').length, tag: document.getElementById('overTag').textContent }));
    check('board', 'a real demo game over (autopilot seed 101, about 53 s of sim): over screen shown, no name form, rank 0, board storage unchanged, no highlighted row',
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

    /* ----- 7b. Seed 7 demo started by a REAL click on "Watch demo": popups, audio, recording ----- */
    console.log('\n7b. Seed 7 demo after a real click: popup overlap audit, audio-on recording');
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
    await page.goto(URL + '?seed=7');
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
    notes.demoAudio = { seed: 7, simSeconds: last.time, pickups: dp.length, hornReadyEvents: dEv.filter((x) => x.type === 'hornReady').length, audioState: last.audio.state, statesSeen: Array.from(states), sequencerSteps: last.audio.steps, peakRms: peak, sfxFired: fired,
      popups: { frames: pa.frames, maxFloats: pa.maxFloats, comboAndFareFrames: pa.both, hornReadyWithPickupFrames: pa.hornWithPickup, slotFrames: pa.slotSeen, slotCopy: pa.copy } };
    console.log('  AUDIO  demo AudioContext state: ' + last.audio.state + ', sequencer steps: ' + last.audio.steps + ', peak RMS: ' + peak + ', sfx fired: ' + JSON.stringify(fired));
    check('audio', 'recording page: no AudioContext and no recorder before the click; the click on Watch demo starts audio (running, music on)', pre.audio.created === false && !preRec.hasRecorder && preRec.chunks === 0 && first.audio.created && first.audio.state === 'running' && first.audio.musicOn, { before: pre.audio.state, after: first.audio.state });
    check('audio', 'demo: output is audible and sfx come from real events (one pickup sfx per pickup, horn ready chime per hornReady)', peak > 0.01 && states.size === 1 && fired.pickup === dp.length && dp.length >= 5 && (fired.ready || 0) === dEv.filter((x) => x.type === 'hornReady').length && (fired.horn || 0) === dEv.filter((x) => x.type === 'horn').length, { peakRms: peak, fired, pickups: dp.length });
    check('popup', 'seed 7 demo: no two live floating popups (or the horn slot) overlap in any sampled frame', pa.frames > 50 && pa.overlaps.length === 0 && pa.floatOffRoad === 0, { frames: pa.frames, maxFloats: pa.maxFloats, overlaps: pa.overlaps });
    check('popup', 'seed 7 demo: combo (BEBA) and fare popups were visible in the same frame', pa.both > 0, { frames: pa.both });
    check('popup', 'seed 7 demo: HORN READY was visible at the same time as pickup text', pa.hornWithPickup > 0 && shotPop, { frames: pa.hornWithPickup });
    check('popup', 'seed 7 demo: HORN READY sits in its dedicated gutter slot: off the road, clear of the matatu sprite, never in the float stack', pa.slotSeen > 0 && pa.slotBad.length === 0 && pa.hornInFloat === 0 && Object.keys(pa.copy).every((k) => /^HORN (READY!?|CHARGING)$/.test(k)), { slotFrames: pa.slotSeen, copy: pa.copy, bad: pa.slotBad });
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

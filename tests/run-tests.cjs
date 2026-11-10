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
  throw new Error('timeout waiting for ' + label + ' (last mode ' + (s && s.mode) + ')');
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

if (require.main !== module) { module.exports = { loadPlaywright, smallScreenChecks, nearMissAndRepair, results, problems }; return; }

(async () => {
  const { pw, from } = loadPlaywright();
  const launchOpts = { headless: !process.env.HEADED, args: ['--autoplay-policy=user-gesture-required'] };
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
    const bad = [], net = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      if (/[\u2014\u2013]/.test(src)) bad.push(f);
      if (/https?:\/\/|\/\/cdn|@import|fetch\(|XMLHttpRequest|WebSocket|<img|<audio|<video|url\(/i.test(src)) net.push(f);
    }
    check('static', 'no em or en dashes anywhere in shipped source (covers all on-screen text)', bad.length === 0, bad);
    check('static', 'no URLs, fetch, XHR, image or media tags in shipped source', net.length === 0, net);
    check('static', 'inline data: favicon is declared, so http serving never requests /favicon.ico', /<link rel="icon"[^>]*href="data:image\/png;base64,[A-Za-z0-9+\/=]+"/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));
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
    const run = await drive(page, {
      ms: 26500, mode: 'play', steer: keySteer(page),
      onTick: async (s, newEv) => {
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
    let badGeom = 0, badHealth = 0, badGrace = 0, shotOver = false, bestSoFar = 0, restartOk = true, overUiOk = true, bestOk = true;
    for (let r = 0; r < 5 && (want.size > 0 || r < 2); r++) {
      if (r === 0) await page.keyboard.press('Enter');
      else { await sleep(750); await page.keyboard.press(r % 2 ? 'Enter' : 'r'); }
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
      if (!shotOver) { shotOver = true; await sleep(250); await page.screenshot({ path: path.join(SHOTS, '05-gameover-desktop.png') }); }
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

  /* ===== 5. Touch on a phone viewport ===== */
  console.log('\n5. Touch controls on a 390x844 phone viewport');
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage(); watch(page, 'phone');
    await page.goto(URL + '?seed=7');
    await page.waitForFunction(() => !!window.MatatuRush);
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
    await sleep(700); await page.keyboard.press('Enter');
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
      await page.waitForFunction(() => !!window.MatatuRush);
      if (cdp) await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: 1280, maxHeight: 720, everyNthFrame: 2 });
      const s = await waitFor(page, (x) => x.tick >= MAXTICK + 60 || x.mode === 'gameover', 40000, 'demo ticks');
      const ev = (await read(page, 0)).e.filter((x) => x.tick <= MAXTICK);
      if (cdp) { await sleep(1500); await cdp.send('Page.stopScreencast').catch(() => {}); }
      await ctx.close();
      return { s, ev, frames };
    };
    const A = await grab(true), B = await grab(false);
    const node = nodeReplay(42, MAXTICK);
    const ja = JSON.stringify(A.ev), jb = JSON.stringify(B.ev), jn = JSON.stringify(node);
    notes.demo = { events: A.ev.length, pickups: A.ev.filter((x) => x.type === 'pickup').length, hits: A.ev.filter((x) => x.type === 'hit').length };
    check('demo', 'autopilot plays through the same input path (source autopilot) and scores', A.s.inputs.autopilot > 5 && A.s.autopilot === true && A.ev.filter((x) => x.type === 'pickup').length >= 3, A.s.inputs);
    check('audio', 'autostarted demo with no gesture never creates an AudioContext', A.s.audio.created === false && B.s.audio.created === false, A.s.audio);
    check('determinism', 'same seed gives an identical event log in two browser runs', A.ev.length > 10 && ja === jb, { events: A.ev.length });
    check('determinism', 'browser event log equals a pure Node replay of js/game.js (events are real simulation output)', ja === jn, { browser: A.ev.length, node: node.length });
    let videoNote = 'not recorded';
    if (A.frames.length > 30) {
      try {
        let list = 'ffconcat version 1.0\n';
        for (let i = 0; i < A.frames.length; i++) {
          const dur = i + 1 < A.frames.length ? Math.max(0.005, A.frames[i + 1].ts - A.frames[i].ts) : 0.04;
          list += 'file ' + path.basename(A.frames[i].file) + '\nduration ' + dur.toFixed(4) + '\n';
        }
        fs.writeFileSync(path.join(FRAMES, 'list.txt'), list);
        const mp4 = path.join(OUT, 'gameplay-demo.mp4');
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(FRAMES, 'list.txt'), '-vf', 'fps=30,scale=1280:720', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-movflags', '+faststart', mp4]);
        const secs = A.frames[A.frames.length - 1].ts - A.frames[0].ts;
        videoNote = 'out/gameplay-demo.mp4 (' + A.frames.length + ' frames, ' + secs.toFixed(1) + ' s, ' + Math.round(fs.statSync(mp4).size / 1024) + ' KB, silent)';
      } catch (e) { videoNote = 'encode failed: ' + String(e.message).slice(0, 120); }
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

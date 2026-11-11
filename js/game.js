/* Matatu Rush: deterministic fixed-step simulation.
   Units: 1 unit = one lane width. d = distance ahead of the player (negative = behind).
   All gameplay randomness uses the seeded rng. No rendering or DOM in this file. */
(function () {
  'use strict';
  var MR = window.MR;
  var clamp = MR.clamp;

  var C = MR.CONST = {
    STEP: 1 / 120,
    LANES: MR.LANES,
    SPAWN_D: 14,
    ZONE_LEN: 150,
    NITRO_TIME: 2.6,
    COMBO_TIME: 5.5,
    MAX_HEALTH: 3,
    START_SPEED: 5.5,
    MAX_SPEED: 12.5,
    SPEED_RAMP: 0.006,
    LANE_RATE: 9,
    P_HALF_W: 0.3,
    P_LEN: 1.5,
    BASE_FARE: 50,
    ASKARI_FINE: 100,
    ZONES: ['TOM MBOYA ST', 'MOI AVENUE', 'NGONG ROAD', 'THIKA ROAD', 'WAIYAKI WAY', 'MOMBASA ROAD', 'EXPRESSWAY']
  };
  var BEST_KEY = 'matatuRush.best';

  function readBest() {
    var v = parseInt(MR.store.get(BEST_KEY, '0'), 10);
    return (isFinite(v) && v > 0) ? v : 0;
  }

  /* ---------- local Top 5 board (this device only) ---------- */
  var TOP_KEY = 'matatuRush.top5';
  var TOP_N = 5;
  var NAME_MAX = 12;
  var ALIASES = ['Dere', 'Konda', 'Makanga', 'Rubani'];

  function cleanName(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  }
  /* parses defensively: anything that is not an array of valid entries gives [] (invalid entries are dropped) */
  function readBoard() {
    var raw = [], out = [], i;
    try { raw = JSON.parse(MR.store.get(TOP_KEY, '[]')); } catch (e) { return []; }
    if (!Array.isArray(raw)) return [];
    for (i = 0; i < raw.length; i++) {
      var r = raw[i];
      if (!r || typeof r !== 'object') continue;
      var name = cleanName(r.name), score = r.score;
      if (!name || typeof score !== 'number' || !isFinite(score)) continue;
      score = Math.floor(score);
      if (score <= 0) continue;
      var id = (typeof r.id === 'string' || typeof r.id === 'number') ? String(r.id).slice(0, 40) : '';
      if (!id) id = 'x' + i + '-' + Math.floor(Math.random() * 1e6).toString(36);
      out.push({ name: name, score: score, id: id, ord: i });
    }
    /* score desc; equal scores keep their stored order (older stays above) */
    out.sort(function (a, b) { return (b.score - a.score) || (a.ord - b.ord); });
    out = out.slice(0, TOP_N);
    for (i = 0; i < out.length; i++) delete out[i].ord;
    return out;
  }
  function writeBoard(list) { MR.store.set(TOP_KEY, JSON.stringify(list)); }
  /* Math.random on purpose: the seeded game RNG must not be touched, so seeded runs stay deterministic */
  function makeAlias() {
    return ALIASES[Math.floor(Math.random() * ALIASES.length)] + ' ' + (100 + Math.floor(Math.random() * 900));
  }
  function makeBoardId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  MR.createGame = function () {
    var g = {
      mode: 'title',
      best: readBest(),
      onEvent: null,
      log: [],
      seq: 0
    };
    var nextId = 1;

    function emit(type, data) {
      var ev = { i: ++g.seq, tick: g.tick, t: Math.round(g.time * 1000) / 1000, type: type };
      if (data) { for (var k in data) ev[k] = data[k]; }
      g.log.push(ev);
      if (g.log.length > 4000) g.log.shift();
      if (g.onEvent) g.onEvent(ev);
      return ev;
    }

    g.reset = function (seed, autopilot) {
      g.seed = seed >>> 0;
      g.rng = MR.mulberry32(g.seed);
      g.autopilot = !!autopilot;
      g.tick = 0; g.time = 0;
      g.dist = 0; g.speed = 3; g.baseSpeed = C.START_SPEED;
      g.level = 0;
      g.score = 0; g.fareAcc = 0;
      g.health = C.MAX_HEALTH;
      g.lane = 1; g.px = 1; g.lastLaneFrom = 1; g.sinceLane = 99;
      g.combo = 0; g.comboTimer = 0;
      g.horn = 1; g.hornReadyFlag = true; g.nitro = 0;
      g.invuln = 0;
      g.ents = [];
      g.rowIndex = 0; g.nextRowAt = 2; g.safe = 1;
      g.newBest = false;
      g.boardRank = 0; g.boardId = null;
      g.apCool = 0; g.apHornHold = 0;
      g.stats = {
        pickups: 0, passengers: 0, bestCombo: 0, nearMiss: 0, smashed: 0, laneChanges: 0,
        horns: 0, repairs: 0, hits: { pothole: 0, boda: 0, askari: 0 }
      };
      g.inputs = { keyboard: 0, touch: 0, mouse: 0, autopilot: 0 };
      g.log = []; g.seq = 0;
      nextId = 1;
    };

    g.start = function (seed, autopilot) {
      g.reset(seed, autopilot);
      g.mode = 'running';
      emit('start', { seed: g.seed, autopilot: g.autopilot });
    };

    /* copy of the saved Top 5 */
    g.board = function () { return readBoard(); };
    /* renames one entry. Trims, collapses spaces, caps at 12 chars; empty keeps the alias. Returns the stored name ('' if the entry is gone). */
    g.setBoardName = function (id, name) {
      var list = readBoard();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) {
          var n = cleanName(name);
          if (n) { list[i].name = n; writeBoard(list); }
          return list[i].name;
        }
      }
      return '';
    };

    g.zoneName = function (level) {
      var z = C.ZONES;
      return z[Math.min(level === undefined ? g.level : level, z.length - 1)];
    };

    /* ---------- input (the only way anything steers the matatu) ---------- */
    g.input = function (action, source) {
      if (g.mode !== 'running') return false;
      source = source || 'keyboard';
      if (g.inputs[source] === undefined) g.inputs[source] = 0;
      g.inputs[source]++;
      if (action === 'left' || action === 'right') {
        var dir = action === 'left' ? -1 : 1;
        var to = g.lane + dir;
        if (to < 0 || to >= C.LANES) { emit('bump', { lane: g.lane, source: source }); return false; }
        g.lastLaneFrom = g.lane;
        g.lane = to;
        g.sinceLane = 0;
        g.stats.laneChanges++;
        emit('lane', { from: g.lastLaneFrom, to: to, source: source });
        return true;
      }
      if (action === 'horn') {
        if (g.horn >= 1 && g.nitro <= 0) {
          g.horn = 0; g.hornReadyFlag = false;
          g.nitro = C.NITRO_TIME;
          g.stats.horns++;
          var scattered = 0;
          for (var i = 0; i < g.ents.length; i++) {
            var e = g.ents[i];
            if (e.type === 'boda' && !e.crashed && !e.scatter && e.d > -1 && e.d < 9) {
              e.scatter = e.x < 1.5 ? -1 : 1;
              scattered++;
            }
          }
          emit('horn', { source: source, scattered: scattered, lane: g.lane });
          return true;
        }
        emit('hornEmpty', { source: source, meter: Math.round(g.horn * 100) / 100 });
        return false;
      }
      return false;
    };

    /* ---------- spawning ---------- */
    function add(e) { e.id = nextId++; g.ents.push(e); return e; }

    function pick(weights) {
      var tot = 0, k;
      for (k in weights) tot += weights[k];
      var x = g.rng() * tot;
      for (k in weights) { x -= weights[k]; if (x < 0) return k; }
      return k;
    }

    function liveBodas() {
      var n = 0;
      for (var i = 0; i < g.ents.length; i++) {
        var e = g.ents[i];
        if (e.type === 'boda' && !e.crashed && !e.scatter) n++;
      }
      return n;
    }

    /* Bodas that a static row spawned now would draw level with before passing the player.
       Used to guarantee at least one open lane (static blockers + aligning bodas <= 3). */
    function aligningBodas() {
      var n = 0;
      for (var i = 0; i < g.ents.length; i++) {
        var e = g.ents[i];
        if (e.type !== 'boda' || e.crashed || e.scatter) continue;
        var t = (C.SPAWN_D - e.d) / e.v;
        var dAt = e.d - (g.baseSpeed - e.v) * t;
        if (dAt > -1.5) n++;
      }
      return n;
    }

    function shuffledLanes(except) {
      var a = [];
      for (var l = 0; l < C.LANES; l++) if (l !== except) a.push(l);
      for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(g.rng() * (i + 1));
        var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
      }
      return a;
    }

    function rowGap() {
      return (2.9 + 0.27 * g.baseSpeed) * (0.92 + g.rng() * 0.16);
    }

    function spawnRow() {
      var r = g.rng, L = g.level, S = C.SPAWN_D;
      g.rowIndex++;
      var mv = r();
      if (mv < 0.33) g.safe--; else if (mv < 0.66) g.safe++;
      g.safe = clamp(g.safe, 0, C.LANES - 1);

      var n = g.rowIndex, type;
      if (n === 1 || n === 2 || n === 4) type = 'stage';
      else if (n === 3) type = 'pothole';
      else if (n === 5) type = 'boda';
      else {
        type = pick({
          none: 0.5,
          stage: 2.6,
          pothole: 2.4 + 0.2 * L,
          combo: 1.3,
          boda: 2.1 + 0.35 * L,
          askari: g.dist > 55 ? 1.4 + 0.25 * L : 0,
          repair: g.health < C.MAX_HEALTH ? 0.4 : 0
        });
      }

      var allowed = Math.max(0, 3 - aligningBodas());
      if (type === 'askari' && allowed < 2) type = 'pothole';
      if (type === 'boda' && liveBodas() >= 2 + Math.min(2, L)) type = 'pothole';
      if ((type === 'pothole' || type === 'combo') && allowed < 1) type = 'stage';

      var blocked = [false, false, false, false];
      var i, lanes;

      if (type === 'pothole' || type === 'combo') {
        var cnt = 1;
        if (L >= 1 && r() < 0.4) cnt++;
        if (L >= 3 && r() < 0.35) cnt++;
        cnt = Math.min(cnt, allowed, 3);
        lanes = shuffledLanes(g.safe);
        for (i = 0; i < cnt; i++) {
          blocked[lanes[i]] = true;
          add({ type: 'pothole', lane: lanes[i], d: S + (r() - 0.5) * 0.5, shape: Math.floor(r() * 1e6) });
        }
      } else if (type === 'askari') {
        var opts = [];
        for (i = 0; i < C.LANES - 1; i++) if (i !== g.safe && i + 1 !== g.safe) opts.push(i);
        var l0 = opts[Math.floor(r() * opts.length)];
        blocked[l0] = blocked[l0 + 1] = true;
        add({ type: 'askari', lane: l0, span: 2, d: S });
        if (L >= 2 && allowed >= 3 && r() < 0.35) {
          lanes = shuffledLanes(g.safe);
          for (i = 0; i < lanes.length; i++) {
            if (!blocked[lanes[i]]) {
              blocked[lanes[i]] = true;
              add({ type: 'pothole', lane: lanes[i], d: S + 0.2, shape: Math.floor(r() * 1e6) });
              break;
            }
          }
        }
      } else if (type === 'boda') {
        var count = (L >= 2 && r() < 0.35) ? 2 : 1;
        lanes = shuffledLanes(-1);
        var placed = 0;
        for (i = 0; i < lanes.length && placed < count; i++) {
          var ln = lanes[i], clear = true;
          for (var j = 0; j < g.ents.length; j++) {
            var o = g.ents[j];
            if (o.type === 'boda' && Math.abs(o.x - ln) < 0.9 && Math.abs(o.d - S) < 3.5) { clear = false; break; }
          }
          if (!clear) continue;
          var kr = r(), kind, v;
          if (n < 9 || kr < 0.42) { kind = 'cruiser'; v = 2.4 + r() * 0.8; }
          else if (kr < 0.8) { kind = 'weaver'; v = 2.6 + r() * 0.8; }
          else { kind = 'loader'; v = 1.6 + r() * 0.5; }
          add({
            type: 'boda', kind: kind, lane: ln, x: ln, d: S + placed * 1.3, v: v,
            signal: 0, signalT: 0, weaveT: 0.6 + r() * 1.2, spin: 0, vx: 0
          });
          placed++;
        }
      } else if (type === 'repair') {
        add({ type: 'repair', lane: g.safe, d: S });
        blocked[g.safe] = true;
      }

      if (type === 'stage' || type === 'combo' || ((type === 'pothole' || type === 'askari') && r() < 0.22)) {
        var free = [];
        for (i = 0; i < C.LANES; i++) if (!blocked[i]) free.push(i);
        if (free.length) {
          var sl = (!blocked[g.safe] && r() < 0.5) ? g.safe : free[Math.floor(r() * free.length)];
          add({ type: 'stage', lane: sl, d: S + 0.1, pax: 2 + Math.floor(r() * 3), taken: false });
        }
      }
    }

    /* ---------- bodas ---------- */
    function coversLane(e, lane) {
      if (e.type === 'askari') return lane >= e.lane && lane < e.lane + e.span;
      return e.lane === lane;
    }

    function staticAhead(lane, d, range) {
      for (var i = 0; i < g.ents.length; i++) {
        var s = g.ents[i];
        if ((s.type === 'pothole' || s.type === 'askari') && coversLane(s, lane)) {
          var gap = s.d - d;
          if (gap > -0.6 && gap < range) return true;
        }
      }
      return false;
    }

    function bodaNear(lane, me, range) {
      for (var i = 0; i < g.ents.length; i++) {
        var o = g.ents[i];
        if (o === me || o.type !== 'boda' || o.crashed || o.scatter) continue;
        if ((Math.abs(o.x - lane) < 0.9 || o.lane === lane) && Math.abs(o.d - me.d) < range) return true;
      }
      return false;
    }

    function updateBoda(e, dt) {
      if (e.scatter) { e.x += e.scatter * dt * 5; e.spin += dt * 3 * e.scatter; return; }
      if (e.crashed) { e.spin += dt * 10; e.x += e.vx * dt; e.v *= (1 - dt * 2.5); return; }
      if (e.x !== e.lane) {
        var mx = 2.6 * dt;
        e.x += clamp(e.lane - e.x, -mx, mx);
      }
      if (e.signal) {
        e.signalT -= dt;
        if (e.signalT <= 0) {
          var to = e.lane + e.signal;
          /* fairness: never cut into the player's lane at close range */
          var unfair = (to === g.lane && e.d < 3.2 && e.d > -1.5);
          if (!unfair) e.lane = to;
          e.signal = 0;
        }
        return;
      }
      if (e.x !== e.lane) return;
      if (staticAhead(e.lane, e.d, 3.2)) {
        var dirs = e.lane < 1.5 ? [1, -1] : [-1, 1];
        for (var k = 0; k < 2; k++) {
          var tl = e.lane + dirs[k];
          if (tl < 0 || tl >= C.LANES) continue;
          if (staticAhead(tl, e.d, 4.2) || bodaNear(tl, e, 1.8)) continue;
          e.signal = dirs[k]; e.signalT = 0.4;
          return;
        }
        return;
      }
      if (e.kind === 'weaver' && e.d > 4.6) {
        e.weaveT -= dt;
        if (e.weaveT <= 0) {
          e.weaveT = 1.2 + g.rng() * 1.6;
          var dir = g.rng() < 0.5 ? -1 : 1;
          var t2 = e.lane + dir;
          if (t2 >= 0 && t2 < C.LANES && !bodaNear(t2, e, 1.8) && !staticAhead(t2, e.d, 4.2)) {
            e.signal = dir; e.signalT = 0.7;
          }
        }
      }
    }

    /* ---------- collisions ---------- */
    function entX(e) {
      if (e.type === 'boda') return e.x;
      if (e.type === 'askari') return e.lane + (e.span - 1) / 2;
      return e.lane;
    }
    function halfW(e) {
      if (e.type === 'boda') return e.kind === 'loader' ? 0.25 : 0.2;
      if (e.type === 'askari') return e.span / 2 - 0.04;
      return 0.28;
    }
    function lenOf(e) {
      if (e.type === 'boda') return 1.0;
      if (e.type === 'askari') return 0.36;
      return 0.6;
    }
    function overlaps(e) {
      return Math.abs(g.px - entX(e)) < halfW(e) + C.P_HALF_W - 0.08 &&
        Math.abs(e.d) < (lenOf(e) + C.P_LEN) / 2 - 0.12;
    }
    g.geom = { entX: entX, halfW: halfW, lenOf: lenOf };

    function gameOver() {
      g.mode = 'gameover';
      if (!g.autopilot && g.score > g.best) {
        g.best = g.score;
        g.newBest = true;
        MR.store.set(BEST_KEY, String(g.best));
      }
      g.boardRank = 0; g.boardId = null;
      if (!g.autopilot && g.score > 0) {
        var board = readBoard();
        if (board.length < TOP_N || g.score > board[board.length - 1].score) {
          var pos = 0;
          while (pos < board.length && board[pos].score >= g.score) pos++;
          var entry = { name: makeAlias(), score: g.score, id: makeBoardId() };
          board.splice(pos, 0, entry);
          board = board.slice(0, TOP_N);
          writeBoard(board);
          g.boardRank = pos + 1; g.boardId = entry.id;
        }
      }
      emit('gameover', {
        rank: g.boardRank,
        score: g.score, best: g.best, newBest: g.newBest, dist: Math.round(g.dist),
        pickups: g.stats.pickups, bestCombo: g.stats.bestCombo
      });
    }

    function hit(e) {
      e.hit = true;
      g.health--;
      g.invuln = 1.5;
      var lostCombo = g.combo;
      g.combo = 0; g.comboTimer = 0;
      g.stats.hits[e.type]++;
      var fine = 0;
      if (e.type === 'askari') { fine = Math.min(g.score, C.ASKARI_FINE); g.score -= fine; }
      if (e.type === 'boda') { e.crashed = true; e.vx = (e.x >= g.px ? 1 : -1) * 2.2; }
      emit('hit', {
        kind: e.type, id: e.id, lane: e.lane, entX: Math.round(entX(e) * 100) / 100,
        d: Math.round(e.d * 100) / 100, px: Math.round(g.px * 100) / 100,
        playerLane: g.lane, health: g.health, fine: fine, lostCombo: lostCombo
      });
      if (g.health <= 0) gameOver();
    }

    /* ---------- autopilot: reads the same state a player sees, uses g.input ---------- */
    function laneThreat(l) {
      var best = Infinity;
      for (var i = 0; i < g.ents.length; i++) {
        var e = g.ents[i];
        if (e.hit || e.gone || e.scatter || e.crashed) continue;
        var cov = false;
        if (e.type === 'pothole' || e.type === 'askari') cov = coversLane(e, l);
        else if (e.type === 'boda') cov = Math.abs(e.x - l) < 0.75 || e.lane === l || (e.signal && e.lane + e.signal === l);
        if (!cov) continue;
        var half = (lenOf(e) + C.P_LEN) / 2;
        if (e.d < -half) continue;
        var rel = Math.max(0.5, g.speed - (e.v || 0));
        var t = Math.max(0, (e.d - half - 0.15) / rel);
        if (t < best) best = t;
      }
      return best;
    }
    function laneReward(l) {
      var v = 0;
      for (var i = 0; i < g.ents.length; i++) {
        var e = g.ents[i];
        if (e.d < 0.2 || e.d > 9 || e.lane !== l) continue;
        if (e.type === 'stage' && !e.taken) v += 30 - e.d * 2;
        if (e.type === 'repair' && !e.taken) v += 40 - e.d * 2;
      }
      return v;
    }
    function autopilotStep(dt) {
      if (g.horn >= 1) g.apHornHold += dt; else g.apHornHold = 0;
      g.apCool -= dt;
      if (g.apCool > 0) return;
      var T = [], val = [], l, bestL = g.lane, bestV = -1e9;
      for (l = 0; l < C.LANES; l++) {
        T[l] = laneThreat(l);
        val[l] = (T[l] > 1.7 ? 100 : T[l] * 55) + laneReward(l) - Math.abs(l - g.lane) * 4;
        if (val[l] > bestV) { bestV = val[l]; bestL = l; }
      }
      var cur = g.lane;
      if (g.nitro <= 0 && g.invuln <= 0 && T[cur] < 0.4) {
        var escL = cur > 0 && T[cur - 1] > 0.35, escR = cur < C.LANES - 1 && T[cur + 1] > 0.35;
        if (!escL && !escR && g.horn >= 1) { g.input('horn', 'autopilot'); g.apCool = 0.2; return; }
      }
      if (g.horn >= 1 && g.apHornHold > 5 && g.nitro <= 0 && T[cur] < 1.2) {
        g.input('horn', 'autopilot'); g.apCool = 0.2; return;
      }
      if (bestL !== cur) {
        var dir = bestL > cur ? 1 : -1;
        var nx = cur + dir;
        if (g.nitro > 0 || T[nx] > 0.3 || T[nx] >= T[cur]) {
          g.input(dir < 0 ? 'left' : 'right', 'autopilot');
          g.apCool = 0.13;
        }
      }
    }

    /* ---------- one fixed step ---------- */
    g.step = function () {
      if (g.mode !== 'running') return;
      var dt = C.STEP;
      g.tick++; g.time += dt;

      g.baseSpeed = Math.min(C.MAX_SPEED, C.START_SPEED + g.dist * C.SPEED_RAMP);
      var target = g.baseSpeed * (g.nitro > 0 ? 1.65 : 1);
      g.speed += (target - g.speed) * Math.min(1, dt * 5);
      var dd = g.speed * dt;
      g.dist += dd;
      g.fareAcc += dd;
      if (g.fareAcc >= 1) { var whole = Math.floor(g.fareAcc); g.score += whole; g.fareAcc -= whole; }

      var lvl = Math.floor(g.dist / C.ZONE_LEN);
      if (lvl !== g.level) { g.level = lvl; emit('zone', { level: lvl, name: g.zoneName(lvl), speed: Math.round(g.baseSpeed * 100) / 100 }); }

      if (g.nitro > 0) {
        g.nitro -= dt;
        if (g.nitro <= 0) { g.nitro = 0; g.invuln = Math.max(g.invuln, 0.7); emit('nitroEnd', {}); }
      } else if (g.horn < 1) {
        g.horn = Math.min(1, g.horn + dt * 0.025);
      }
      if (g.horn >= 1 && !g.hornReadyFlag) { g.hornReadyFlag = true; emit('hornReady', {}); }
      if (g.invuln > 0) g.invuln = Math.max(0, g.invuln - dt);
      if (g.combo > 0) {
        g.comboTimer -= dt;
        if (g.comboTimer <= 0) { emit('comboEnd', { combo: g.combo }); g.combo = 0; g.comboTimer = 0; }
      }

      var mxm = C.LANE_RATE * dt;
      g.px += clamp(g.lane - g.px, -mxm, mxm);
      g.sinceLane += dt;

      if (g.autopilot) autopilotStep(dt);

      while (g.dist >= g.nextRowAt) { spawnRow(); g.nextRowAt += rowGap(); }

      for (var i = 0; i < g.ents.length; i++) {
        var e = g.ents[i];
        if (e.type === 'boda') {
          updateBoda(e, dt);
          e.d -= (g.speed - e.v) * dt;
        } else {
          e.d -= dd;
        }

        if (e.type === 'stage' || e.type === 'repair') {
          if (!e.taken && Math.abs(g.px - e.lane) < 0.62 && Math.abs(e.d) < 1.25) {
            e.taken = true;
            if (e.type === 'repair') {
              if (g.health < C.MAX_HEALTH) g.health++;
              g.stats.repairs++;
              g.score += 25;
              emit('repair', { lane: e.lane, health: g.health });
            } else {
              g.combo++;
              g.comboTimer = C.COMBO_TIME;
              if (g.combo > g.stats.bestCombo) g.stats.bestCombo = g.combo;
              var mult = Math.min(g.combo, 9);
              var fare = C.BASE_FARE * mult * (g.nitro > 0 ? 2 : 1);
              g.score += fare;
              g.stats.pickups++;
              g.stats.passengers += e.pax;
              if (g.nitro <= 0) g.horn = Math.min(1, g.horn + 0.34);
              emit('pickup', {
                id: e.id, lane: e.lane, d: Math.round(e.d * 100) / 100, px: Math.round(g.px * 100) / 100,
                playerLane: g.lane, fare: fare, combo: g.combo, mult: mult, pax: e.pax, score: g.score
              });
            }
          }
        } else if (!e.hit && !e.gone && !e.scatter && !e.crashed) {
          if (overlaps(e)) {
            if (g.nitro > 0) {
              e.gone = true; e.hit = true;
              g.stats.smashed++;
              g.score += 10;
              if (e.type === 'boda') { e.gone = false; e.scatter = e.x >= g.px ? 1 : -1; }
              emit('smash', { kind: e.type, id: e.id, lane: e.lane });
            } else if (g.invuln > 0) {
              e.hit = true; /* grace: this obstacle can never hurt later */
            } else {
              hit(e);
              if (g.mode !== 'running') return;
            }
          } else if (!e.nm && e.d < -((lenOf(e) + C.P_LEN) / 2) && e.d > -3) {
            e.nm = true;
            var wasIn = e.type === 'boda' ? Math.round(e.x) === g.lastLaneFrom : coversLane(e, g.lastLaneFrom);
            if (wasIn && g.sinceLane < 0.6 && g.nitro <= 0 && Math.abs(g.px - entX(e)) < halfW(e) + 1.3) {
              g.stats.nearMiss++;
              g.score += 25;
              if (g.nitro <= 0) g.horn = Math.min(1, g.horn + 0.06);
              emit('nearMiss', { kind: e.type, id: e.id, lane: e.lane, playerLane: g.lane });
            }
          }
        }
      }

      for (var k = g.ents.length - 1; k >= 0; k--) {
        var q = g.ents[k];
        if (q.d < -5 || q.d > 30 || q.x < -4 || q.x > 8) g.ents.splice(k, 1);
      }
    };

    /* ---------- read-only snapshot (deep copy) ---------- */
    function r2(v) { return Math.round(v * 100) / 100; }
    g.snapshot = function () {
      var ents = [];
      for (var i = 0; i < g.ents.length; i++) {
        var e = g.ents[i];
        var o = { id: e.id, type: e.type, lane: e.lane, d: r2(e.d) };
        if (e.type === 'boda') { o.kind = e.kind; o.x = r2(e.x); o.v = r2(e.v); o.signal = e.signal; o.crashed = !!e.crashed; o.scatter = e.scatter || 0; }
        if (e.type === 'askari') o.span = e.span;
        if (e.type === 'stage' || e.type === 'repair') o.taken = !!e.taken;
        if (e.type === 'stage') o.pax = e.pax;
        if (e.hit) o.hit = true;
        if (e.gone) o.gone = true;
        ents.push(o);
      }
      return {
        version: MR.VERSION, mode: g.mode, seed: g.seed, autopilot: g.autopilot,
        tick: g.tick, time: r2(g.time), dist: r2(g.dist), speed: r2(g.speed), baseSpeed: r2(g.baseSpeed),
        level: g.level, zone: g.zoneName(), score: g.score, best: g.best, newBest: g.newBest,
        board: readBoard(), boardRank: g.boardRank,
        health: g.health, maxHealth: C.MAX_HEALTH,
        combo: g.combo, comboTimer: r2(g.comboTimer),
        horn: { meter: r2(g.horn), ready: g.horn >= 1 && g.nitro <= 0, nitro: g.nitro > 0, nitroTime: r2(g.nitro) },
        player: { lane: g.lane, x: r2(g.px), invuln: r2(g.invuln) },
        lanes: C.LANES,
        stats: JSON.parse(JSON.stringify(g.stats)),
        inputs: JSON.parse(JSON.stringify(g.inputs)),
        entities: ents,
        eventCount: g.seq
      };
    };
    g.events = function (sinceSeq) {
      var out = [];
      sinceSeq = sinceSeq || 0;
      for (var i = 0; i < g.log.length; i++) if (g.log[i].i > sinceSeq) out.push(JSON.parse(JSON.stringify(g.log[i])));
      return out;
    };

    g.reset(1, false);
    return g;
  };
})();

/* Matatu Rush: canvas renderer, particles and screen effects. Visual only: uses Math.random
   freely, never touches the gameplay rng. */
(function () {
  'use strict';
  var MR = window.MR, Art = MR.Art, hash = MR.hash;
  var R = MR.Render = {};

  var cv, ctx, W = 0, H = 0, dpr = 1, u = 80, roadX = 0, roadW = 0, py = 0;
  var sprites = null, vignette = null, asphalt = null, asphaltPat = null;
  var t = 0, idle = 0;
  var parts = [], texts = [], rain = [], banner = null;
  var trauma = 0, flashHit = 0, flashPick = 0, punch = null, hudBottom = 96;
  var motion = MR.reducedMotion ? 0.2 : 1;

  /* easing: overshoot for "pop", quartic out for "settle" */
  function outBack(k) { var m = k - 1; return 1 + 2.70158 * m * m * m + 1.70158 * m * m; }
  function outQuart(k) { var m = 1 - k; return 1 - m * m * m * m; }

  var SIGNS = ['KINYOZI', 'HOTELI', 'CHIPS MWITU', 'NYAMA CHOMA', 'DUKA', 'SIMU', 'CHAI MOTO', 'SALON', 'MALI MALI',
    'MUTURA', 'SMOKIE PASUA', 'CYBER', 'FUNDI', 'MITUMBA', 'MANDAZI', 'MAZIWA'];
  var NEON = ['#ff2d95', '#21e6ff', '#ffe14a', '#b6ff3c', '#ff8a1f', '#a06bff'];
  var ROOFS = ['#241b3c', '#1b2542', '#2b1e31', '#15293b', '#2a2336', '#1d2030'];

  R.init = function (canvas) { cv = canvas; ctx = cv.getContext('2d'); };

  R.resize = function (bottomInset) {
    W = Math.max(200, window.innerWidth); H = Math.max(200, window.innerHeight);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    u = Math.min(W / 4.7, H / 8.6);
    roadW = 4 * u; roadX = (W - roadW) / 2;
    py = H - (bottomInset || 0) - u * 1.0;
    sprites = Art.buildSprites(u * dpr);

    vignette = Art.mk(Math.ceil(W / 4), Math.ceil(H / 4));
    var vc = vignette.getContext('2d');
    var g = vc.createRadialGradient(vignette.width / 2, vignette.height * 0.55, Math.min(vignette.width, vignette.height) * 0.3,
      vignette.width / 2, vignette.height / 2, Math.max(vignette.width, vignette.height) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(2,2,10,0.78)');
    vc.fillStyle = g; vc.fillRect(0, 0, vignette.width, vignette.height);

    if (!asphalt) {
      asphalt = Art.mk(256, 256);
      var ac = asphalt.getContext('2d'), rng = MR.mulberry32(99);
      for (var i = 0; i < 1500; i++) {
        var b = rng();
        ac.fillStyle = b < 0.5 ? 'rgba(0,0,0,' + (0.1 + rng() * 0.25) + ')' : 'rgba(170,190,255,' + (0.02 + rng() * 0.07) + ')';
        ac.fillRect(rng() * 256, rng() * 256, 1 + rng() * 2, 1 + rng() * 3);
      }
      for (i = 0; i < 26; i++) {
        ac.fillStyle = 'rgba(150,180,255,' + (0.02 + rng() * 0.035) + ')';
        ac.fillRect(rng() * 256, rng() * 256, 2 + rng() * 3, 30 + rng() * 80);
      }
    }
    asphaltPat = ctx.createPattern(asphalt, 'repeat');

    rain = [];
    var n = Math.min(170, Math.round(W * H / 8000));
    for (var k = 0; k < n; k++) rain.push({ x: Math.random() * W, y: Math.random() * H, l: 8 + Math.random() * 14, v: 700 + Math.random() * 500 });
  };

  R.setHudBottom = function (px) { if (px > 0) hudBottom = px; };

  /* Where the announcement banner goes. Wide screens: the left kerb-side gutter, clear of the
     road. Narrow screens: a compact strip tucked directly under the HUD. Never mid-road. */
  function bannerSpot(demo) {
    var gutter = roadX >= 3 * u;
    if (gutter) {
      var gs = MR.clamp(0.5 * u, 18, 40);
      return { zone: 'gutter', cx: (roadX - 0.25 * u) / 2, cy: H * 0.42, size: gs, maxW: roadX - 0.25 * u - 24 };
    }
    var s = MR.clamp(0.34 * u, 15, 26);
    return { zone: 'hud', cx: W / 2, cy: hudBottom - 8 + (demo ? 20 : 0) + s / 2, size: s, maxW: W * 0.62 };
  }

  R.layout = function () {
    var b = null;
    if (banner && banner.box) b = { text: banner.s, zone: banner.box.zone, x: Math.round(banner.box.x), y: Math.round(banner.box.y), w: Math.round(banner.box.w), h: Math.round(banner.box.h) };
    return { w: W, h: H, unit: Math.round(u * 100) / 100, roadX: Math.round(roadX), roadW: Math.round(roadW), playerY: Math.round(py), dpr: dpr,
      hudBottom: Math.round(hudBottom), banner: b, shake: Math.round(trauma * 1000) / 1000, particles: parts.length };
  };

  function laneX(lx) { return roadX + (lx + 0.5) * u; }
  function sy(d) { return py - d * u; }
  R.laneX = laneX; R.sy = sy;

  /* ---------- fx api ---------- */
  /* Trauma model: events ADD trauma (0..1), it decays linearly, the offset uses trauma squared. */
  R.shake = function (m) { trauma = Math.min(1, trauma + m); };
  /* Squash and stretch on the matatu sprite only (visual, hitbox untouched). amt > 0 squashes wide. */
  R.punch = function (amt) { if (!MR.reducedMotion) punch = { a: amt, life: 0, max: 0.22 }; };
  /* One or two frame white "hero" flash at a contact point. Skipped for reduced motion. */
  R.impact = function (lx, d) {
    if (MR.reducedMotion) return;
    parts.push({ x: laneX(lx), y: sy(d), vx: 0, vy: 0, life: 0, max: 0.05, size: u * 0.42, color: '#ffffff', type: 'hero', grav: 0 });
  };
  R.flash = function (kind) { if (kind === 'hit') flashHit = 1; else flashPick = 1; };
  R.burst = function (lx, d, color, n, speed, type) {
    var x = laneX(lx), y = sy(d);
    for (var i = 0; i < n && parts.length < 420; i++) {
      var a = Math.random() * Math.PI * 2, v = speed * u * (0.3 + Math.random() * 0.9);
      parts.push({
        x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (type === 'coin' ? u * 2.2 : 0),
        life: 0, max: 0.35 + Math.random() * 0.5, size: (type === 'coin' ? 0.07 : 0.035 + Math.random() * 0.04) * u,
        color: color, type: type || 'spark', grav: type === 'coin' ? u * 9 : (type === 'smoke' ? -u * 0.6 : u * 2)
      });
    }
  };
  R.ring = function (lx, d, color) {
    parts.push({ x: laneX(lx), y: sy(d), vx: 0, vy: 0, life: 0, max: 0.45, size: u * 0.3, color: color, type: 'ring', grav: 0 });
  };
  R.text = function (str, lx, d, color, sizeU) {
    texts.push({ s: str, x: laneX(lx), y: sy(d), color: color || '#fff', size: (sizeU || 0.34) * u, life: 0, max: 1.1 });
    if (texts.length > 14) texts.shift();
  };
  R.banner = function (str, color, sub) { banner = { s: str, sub: sub || '', color: color || '#ffe14a', life: 0, max: 1.25, box: null }; };
  R.clearFx = function () { parts.length = 0; texts.length = 0; banner = null; trauma = 0; flashHit = 0; flashPick = 0; punch = null; };

  /* ---------- scenery ---------- */
  function sideX(side, o) { return side < 0 ? roadX - o * u : roadX + roadW + o * u; }
  function sideRect(side, o1, o2, y, h) {
    var x1 = sideX(side, o1), x2 = sideX(side, o2);
    ctx.fillRect(Math.min(x1, x2), y, Math.abs(x2 - x1), h);
  }
  function mod2(j) { return ((j % 2) + 2) % 2; }

  function drawShop(side, si, b, dist, accent, BL) {
    var h1 = hash(b * 7 + si * 131 + 11), h2 = hash(b * 31 + si * 57 + 23), h3 = hash(b * 53 + si * 17 + 5);
    var depth = 1.35 + h1 * 0.45;
    var wp1 = b * BL + 0.08, wp2 = (b + 1) * BL - 0.08;
    var y = sy(wp2 - dist), h = (wp2 - wp1) * u;
    ctx.fillStyle = ROOFS[Math.floor(h2 * ROOFS.length)];
    sideRect(side, 1.1, 1.1 + depth, y, h);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    sideRect(side, 1.18, 1.1 + depth - 0.08, y + 0.08 * u, h - 0.16 * u);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    sideRect(side, 1.24, 1.1 + depth - 0.14, y + 0.14 * u, h - 0.28 * u);
    /* water tank */
    var tx = sideX(side, 1.1 + depth * (0.5 + h2 * 0.3)), ty = y + h * (0.2 + h3 * 0.6);
    ctx.fillStyle = '#07070d'; Art.circ(ctx, tx, ty, 0.21 * u); ctx.fill();
    ctx.strokeStyle = '#4a5174'; ctx.lineWidth = Math.max(1, 0.03 * u); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; Art.circ(ctx, tx, ty, 0.12 * u); ctx.stroke();
    /* lit skylight */
    if (h3 > 0.45) {
      var kx = sideX(side, 1.1 + depth * 0.3), ky = y + h * (h1 > 0.5 ? 0.75 : 0.3);
      Art.drawGlow(ctx, '#ffd98a', kx, ky, 0.9 * u, 0.9 * u, 0.35);
      ctx.fillStyle = '#ffd98a'; ctx.fillRect(kx - 0.09 * u, ky - 0.07 * u, 0.18 * u, 0.14 * u);
    }
    /* striped awning over the pavement */
    var col = h1 < 0.35 ? accent : NEON[Math.floor(h3 * NEON.length)];
    var stripes = Math.floor((wp2 - wp1 - 0.3) / 0.22);
    for (var s = 0; s < stripes; s++) {
      ctx.fillStyle = s % 2 ? 'rgba(10,10,20,0.9)' : col;
      ctx.globalAlpha = s % 2 ? 1 : 0.5;
      sideRect(side, 0.86, 1.14, y + 0.15 * u + s * 0.22 * u, 0.22 * u);
    }
    ctx.globalAlpha = 1;
    /* neon sign */
    var name = SIGNS[Math.floor(h2 * 997) % SIGNS.length];
    var flick = (h3 > 0.8 && Math.sin(t * 23 + b) > 0.6) ? 0.35 : 1;
    var cx = sideX(side, 1.48), cy = y + h / 2;
    Art.drawGlow(ctx, col, sideX(side, 0.9), cy, 2.6 * u, h * 1.25, 0.3 * flick);
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(side < 0 ? -Math.PI / 2 : Math.PI / 2);
    ctx.font = 'italic 900 ' + (0.27 * u) + 'px ' + Art.FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var tw = Math.min(h - 0.5 * u, ctx.measureText(name).width + 0.3 * u);
    ctx.globalAlpha = flick;
    ctx.fillStyle = 'rgba(5,5,14,0.85)'; Art.rr(ctx, -tw / 2, -0.21 * u, tw, 0.42 * u, 0.07 * u); ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5, 0.03 * u); ctx.stroke();
    ctx.fillStyle = col; ctx.fillText(name, 0, 0.015 * u, tw - 0.16 * u);
    ctx.globalAlpha = flick * 0.6; ctx.fillStyle = '#fff'; ctx.fillText(name, 0, 0.015 * u, tw - 0.16 * u);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function drawSides(dist, accent) {
    var maxO = roadX / u;
    if (maxO < 0.04) return;
    var wpMin = dist - (H - py) / u - 1, wpMax = dist + py / u + 1, j, y;
    for (var si = 0; si < 2; si++) {
      var side = si ? 1 : -1;
      ctx.fillStyle = '#0a0c17';
      ctx.fillRect(side < 0 ? -20 : roadX + roadW, -20, roadX + 20, H + 40);
      /* far ground: trees and back roofs */
      if (maxO > 2.9) {
        for (j = Math.floor(wpMin / 3.7); j * 3.7 < wpMax; j++) {
          var a1 = hash(j * 13 + si * 71 + 3), a2 = hash(j * 19 + si * 37 + 9);
          y = sy(j * 3.7 + 3.5 - dist);
          if (a1 < 0.62) {
            ctx.fillStyle = ROOFS[Math.floor(a2 * ROOFS.length)];
            ctx.globalAlpha = 0.75;
            sideRect(side, 3.25, 3.25 + 1.5 + a2, y, 3.3 * u);
            ctx.globalAlpha = 1;
            ctx.fillStyle = 'rgba(255,217,138,' + (0.5 + 0.3 * Math.sin(t * 2 + j)) + ')';
            for (var wi = 0; wi < 3; wi++) {
              if (hash(j * 5 + wi * 3 + si) < 0.55) ctx.fillRect(sideX(side, 3.6 + wi * 0.45) - 0.06 * u, y + (0.5 + wi * 0.8) * u, 0.12 * u, 0.2 * u);
            }
          } else {
            for (var tr = 0; tr < 3; tr++) {
              var tx = sideX(side, 3.6 + hash(j * 7 + tr) * 1.6), ty = y + (0.5 + tr * 1.1) * u, trr = (0.45 + hash(j + tr * 9) * 0.3) * u;
              ctx.fillStyle = '#0d2a22'; Art.circ(ctx, tx, ty, trr); ctx.fill();
              ctx.fillStyle = '#14402f'; Art.circ(ctx, tx - trr * 0.2, ty - trr * 0.2, trr * 0.6); ctx.fill();
            }
          }
          /* distant window lights further out */
          for (var q = 0; q < 4; q++) {
            var qx = sideX(side, 5.4 + hash(j * 3 + q * 11 + si) * Math.max(0, maxO - 5.4));
            ctx.fillStyle = q % 2 ? 'rgba(255,217,138,0.5)' : 'rgba(120,200,255,0.4)';
            ctx.fillRect(qx, y + hash(j + q * 5) * 3.5 * u, 0.06 * u, 0.06 * u);
          }
        }
      }
      /* pavement */
      ctx.fillStyle = '#1a1c2e';
      sideRect(side, 0.14, 1.1, -20, H + 40);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (j = Math.floor(wpMin / 0.5); j * 0.5 < wpMax; j++) {
        y = Math.round(sy(j * 0.5 - dist)) + 0.5;
        ctx.moveTo(sideX(side, 0.14), y); ctx.lineTo(sideX(side, 1.1), y);
      }
      ctx.stroke();
      /* shops */
      if (maxO > 0.8) {
        var BL = 3.3;
        for (j = Math.floor(wpMin / BL); j * BL < wpMax; j++) drawShop(side, si, j, dist, accent, BL);
      }
      /* pavement life: hawker umbrellas and pedestrians */
      for (j = Math.floor(wpMin / 1.9); j * 1.9 < wpMax; j++) {
        var p1 = hash(j * 11 + si * 97 + 1), p2 = hash(j * 23 + si * 41 + 7);
        y = sy(j * 1.9 + p2 * 1.2 - dist);
        var px = sideX(side, 0.42 + p2 * 0.3);
        if (p1 < 0.34) {
          var ur = 0.25 * u, uc = NEON[Math.floor(p2 * NEON.length)];
          ctx.fillStyle = 'rgba(0,0,0,0.4)'; Art.circ(ctx, px + 0.04 * u, y + 0.04 * u, ur); ctx.fill();
          for (var sg = 0; sg < 8; sg++) {
            ctx.beginPath(); ctx.moveTo(px, y); ctx.arc(px, y, ur, sg * Math.PI / 4, (sg + 1) * Math.PI / 4); ctx.closePath();
            ctx.fillStyle = sg % 2 ? '#d8d8e6' : uc; ctx.globalAlpha = 0.7; ctx.fill();
          }
          ctx.globalAlpha = 1;
        } else if (p1 < 0.7) {
          Art.drawPerson(ctx, u * 0.85, px, y, NEON[Math.floor(p1 * 17) % NEON.length], 0);
          if (p2 > 0.5) Art.drawPerson(ctx, u * 0.85, px + 0.2 * u, y + 0.12 * u, NEON[Math.floor(p2 * 13) % NEON.length], 0);
        }
      }
      /* painted kerb */
      for (j = Math.floor(wpMin / 0.6); j * 0.6 < wpMax; j++) {
        ctx.fillStyle = mod2(j) ? '#cda814' : '#14141c';
        sideRect(side, 0, 0.14, sy((j + 1) * 0.6 - dist), 0.6 * u + 1);
      }
    }
  }

  function drawRoad(dist, accent, speedF) {
    var g = ctx.createLinearGradient(roadX, 0, roadX + roadW, 0);
    g.addColorStop(0, '#0d0f1f'); g.addColorStop(0.5, '#181c34'); g.addColorStop(1, '#0d0f1f');
    ctx.fillStyle = g; ctx.fillRect(roadX, -20, roadW, H + 40);
    ctx.save();
    ctx.beginPath(); ctx.rect(roadX, -20, roadW, H + 40); ctx.clip();
    ctx.translate(roadX, (dist * u) % 256);
    ctx.fillStyle = asphaltPat; ctx.fillRect(0, -300, roadW, H + 600);
    ctx.restore();
    var j, y;
    /* wet sheen down each lane */
    for (j = 0; j < 4; j++) {
      ctx.fillStyle = 'rgba(110,150,255,0.035)';
      ctx.fillRect(roadX + (j + 0.28) * u, -20, 0.44 * u, H + 40);
    }
    var wpMin = dist - (H - py) / u - 1, wpMax = dist + py / u + 1;
    /* puddles with neon reflections */
    for (j = Math.floor(wpMin / 4.5) - 1; j * 4.5 < wpMax; j++) {
      var h1 = hash(j * 17 + 3);
      if (h1 > 0.62) continue;
      var x = roadX + (0.4 + hash(j * 29 + 1) * 3.2) * u;
      y = sy(j * 4.5 + hash(j * 5 + 2) * 3 - dist);
      var rx = (0.3 + hash(j * 3 + 8) * 0.3) * u, ry = rx * 0.4;
      ctx.fillStyle = 'rgba(60,90,190,0.1)';
      ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = accent; ctx.globalAlpha = 0.22; ctx.lineWidth = Math.max(1, 0.02 * u);
      ctx.beginPath(); ctx.ellipse(x, y, rx * 0.8, ry * 0.7, 0, Math.PI * 1.05, Math.PI * 1.7); ctx.stroke();
      ctx.globalAlpha = 0.3; ctx.fillStyle = '#fff';
      ctx.fillRect(x - rx * 0.3, y - ry * 0.15 + Math.sin(t * 3 + j) * 1.5, rx * 0.45, Math.max(1, 0.015 * u));
      ctx.globalAlpha = 1;
    }
    /* lane dashes, stretched a touch with speed */
    var period = 2.2, len = 0.85 + speedF * 0.5;
    ctx.fillStyle = 'rgba(236,240,255,0.82)';
    for (var l = 1; l < 4; l++) {
      for (j = Math.floor(wpMin / period); j * period < wpMax; j++) {
        ctx.fillRect(roadX + l * u - 0.028 * u, sy(j * period + len - dist), 0.056 * u, len * u);
      }
    }
    /* yellow edge lines */
    ctx.fillStyle = '#e2b91c';
    ctx.fillRect(roadX + 0.06 * u, -20, 0.05 * u, H + 40);
    ctx.fillRect(roadX + roadW - 0.11 * u, -20, 0.05 * u, H + 40);
  }

  function drawStreetlights(dist) {
    var wpMin = dist - (H - py) / u - 4, wpMax = dist + py / u + 4;
    for (var k = Math.floor(wpMin / 6); k * 6 < wpMax; k++) {
      var side = mod2(k) ? 1 : -1;
      var y = sy(k * 6 + 3 - dist);
      var hx = sideX(side, -0.35), bx = sideX(side, 0.3);
      Art.drawGlow(ctx, '#ffb24a', sideX(side, -0.7), y, 5.2 * u, 5.2 * u, 0.42);
      Art.drawGlow(ctx, '#ffb24a', sideX(side, -0.8), y + 0.4 * u, 1.3 * u, 7 * u, 0.2);
      ctx.strokeStyle = '#2b2f45'; ctx.lineWidth = Math.max(2, 0.05 * u); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(bx, y); ctx.lineTo(hx, y); ctx.stroke();
      ctx.fillStyle = '#3a3f5c'; Art.circ(ctx, bx, y, 0.07 * u); ctx.fill();
      ctx.fillStyle = '#fff1cf'; Art.rr(ctx, hx - 0.1 * u, y - 0.055 * u, 0.2 * u, 0.11 * u, 0.04 * u); ctx.fill();
    }
  }

  /* ---------- entities ---------- */
  function drawSprite(sp, x, y, rot, alpha) {
    ctx.save();
    ctx.translate(x, y);
    if (rot) ctx.rotate(rot);
    if (alpha !== undefined) ctx.globalAlpha = alpha;
    ctx.drawImage(sp.img, -sp.w * u / 2, -sp.h * u / 2, sp.w * u, sp.h * u);
    ctx.restore();
  }

  function drawEntities(g, accent) {
    var ents = g.ents.slice().sort(function (a, b) {
      var oa = a.type === 'stage' ? 0 : (a.type === 'boda' ? 2 : 1), ob = b.type === 'stage' ? 0 : (b.type === 'boda' ? 2 : 1);
      return oa !== ob ? oa - ob : b.d - a.d;
    });
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i], y = sy(e.d);
      if (y < -3 * u || y > H + 3 * u) continue;
      if (e.type === 'stage') {
        ctx.save(); ctx.translate(laneX(e.lane), y); Art.drawStage(ctx, u, e, t); ctx.restore();
      } else if (e.type === 'pothole') {
        ctx.save(); ctx.translate(laneX(e.lane), y);
        if (e.gone) ctx.globalAlpha = 0.35;
        Art.drawPothole(ctx, u, e.shape, t, accent); ctx.restore();
      } else if (e.type === 'repair') {
        if (e.taken) continue;
        ctx.save(); ctx.translate(laneX(e.lane), y); Art.drawRepair(ctx, u, t); ctx.restore();
      } else if (e.type === 'askari') {
        ctx.save(); ctx.translate(laneX(e.lane + (e.span - 1) / 2), y); Art.drawAskari(ctx, u, e.span, t, !!e.gone); ctx.restore();
      } else if (e.type === 'boda') {
        var x = laneX(e.x), rot = (e.lane - e.x) * 0.4 + (e.spin || 0);
        if (!e.crashed && !e.scatter) {
          Art.drawGlow(ctx, '#fff0b0', x, y - 0.95 * u, 1.0 * u, 1.9 * u, 0.4);
          Art.drawGlow(ctx, '#ff2a2a', x, y + 0.55 * u, 0.7 * u, 0.9 * u, 0.55);
          if (e.kind === 'weaver') Art.drawGlow(ctx, '#ff7a1a', x, y, 1.3 * u, 1.5 * u, 0.22);
        }
        drawSprite(sprites['boda_' + e.kind], x, y, rot);
        if (e.signal && Math.floor(t * 9) % 2 === 0) {
          var ix = x + e.signal * 0.3 * u;
          Art.drawGlow(ctx, '#ffae00', ix, y - 0.1 * u, 0.9 * u, 0.9 * u, 0.95);
          ctx.fillStyle = '#ffd24a';
          Art.poly(ctx, [[ix + e.signal * 0.14 * u, y - 0.1 * u], [ix - e.signal * 0.02 * u, y - 0.22 * u], [ix - e.signal * 0.02 * u, y + 0.02 * u]]);
          ctx.fill();
        }
      }
    }
  }

  function drawPlayer(g) {
    var x = laneX(g.px), y = py, rot = (g.lane - g.px) * 0.24;
    if (g.mode === 'gameover') rot = 0.3;
    var nit = g.nitro > 0;
    /* neon underglow reflecting on the wet road */
    Art.drawGlow(ctx, nit ? '#21e6ff' : '#ff2d95', x, y + 0.1 * u, 1.9 * u, 2.7 * u, 0.5 + 0.1 * Math.sin(t * 8));
    Art.drawGlow(ctx, '#ff2a2a', x, y + 0.95 * u, 1.1 * u, 1.3 * u, 0.5);
    /* headlights */
    var sp = sprites.cone;
    ctx.save();
    ctx.translate(x, y - 0.7 * u); ctx.rotate(rot);
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.5;
    ctx.drawImage(sp.img, -sp.w * u / 2, -sp.h * u, sp.w * u, sp.h * u);
    ctx.restore();
    if (nit) {
      /* nitro flames */
      for (var f = -1; f <= 1; f += 2) {
        var fl = (0.5 + Math.random() * 0.5) * u, fx = x + f * 0.17 * u, fy = y + 0.74 * u;
        var gr = ctx.createLinearGradient(0, fy, 0, fy + fl);
        gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.3, '#21e6ff'); gr.addColorStop(1, 'rgba(160,107,255,0)');
        ctx.fillStyle = gr;
        Art.poly(ctx, [[fx - 0.09 * u, fy], [fx + 0.09 * u, fy], [fx, fy + fl]]); ctx.fill();
      }
      Art.drawGlow(ctx, '#21e6ff', x, y + 1.0 * u, 1.6 * u, 1.8 * u, 0.7);
    }
    var blink = g.invuln > 0 && g.nitro <= 0 && g.mode === 'running' && Math.floor(t * 14) % 2 === 0;
    if (punch) {
      var pf = punch.a * (1 - outBack(Math.min(1, punch.life / punch.max)));
      ctx.save(); ctx.translate(x, y); ctx.scale(1 + pf, 1 - pf); ctx.translate(-x, -y);
      drawSprite(sprites.matatu, x, y, rot, blink ? 0.35 : 1);
      ctx.restore();
    } else drawSprite(sprites.matatu, x, y, rot, blink ? 0.35 : 1);
    /* roof LED chase */
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    for (var i = 0; i < 5; i++) {
      var on = (Math.floor(t * 10) + i) % 5 === 0;
      ctx.fillStyle = on ? '#ffffff' : NEON[i % NEON.length];
      ctx.globalAlpha = on ? 1 : 0.75;
      Art.circ(ctx, (-0.18 + i * 0.09) * u, -0.345 * u, 0.022 * u); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (nit) {
      ctx.strokeStyle = 'rgba(33,230,255,' + (0.5 + 0.3 * Math.sin(t * 20)) + ')'; ctx.lineWidth = Math.max(2, 0.04 * u);
      ctx.beginPath(); ctx.ellipse(0, 0, 0.5 * u, 0.98 * u, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
    /* tyre spray */
    if (g.mode === 'running' && parts.length < 380) {
      for (var s = -1; s <= 1; s += 2) {
        parts.push({
          x: x + s * 0.27 * u, y: y + 0.7 * u, vx: s * (0.3 + Math.random() * 0.8) * u, vy: (1.5 + Math.random() * 2.5) * u,
          life: 0, max: 0.3 + Math.random() * 0.25, size: (0.02 + Math.random() * 0.03) * u,
          color: nit ? 'rgba(160,240,255,0.6)' : 'rgba(170,190,255,0.35)', type: 'dot', grav: 0
        });
      }
    }
    if (g.mode === 'gameover' && Math.random() < 0.3 && parts.length < 380) {
      parts.push({ x: x + (Math.random() - 0.5) * 0.3 * u, y: y - 0.6 * u, vx: (Math.random() - 0.5) * u, vy: -u * (0.5 + Math.random()),
        life: 0, max: 1.2, size: 0.12 * u, color: 'rgba(160,160,180,0.35)', type: 'smoke', grav: -u * 0.4 });
    }
  }

  function drawParticles(dt) {
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.life += dt;
      if (p.life >= p.max) { parts.splice(i, 1); continue; }
      p.vy += p.grav * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      var k = 1 - p.life / p.max;
      ctx.globalAlpha = k;
      if (p.type === 'ring') {
        /* fast in, slow out; the line thins instead of lingering */
        ctx.strokeStyle = p.color; ctx.lineWidth = Math.max(1.5, 0.07 * u * k);
        Art.circ(ctx, p.x, p.y, p.size + outQuart(1 - k) * u * 1.15); ctx.stroke();
      } else if (p.type === 'hero') {
        ctx.globalAlpha = 0.9; ctx.fillStyle = p.color; Art.circ(ctx, p.x, p.y, p.size); ctx.fill();
      } else if (p.type === 'spark') {
        /* hard three step ramp (white core, colour, dim tail) and a shrinking streak: no soft fade */
        ctx.globalAlpha = k > 0.35 ? 1 : 0.55;
        ctx.strokeStyle = k > 0.78 ? '#ffffff' : p.color;
        ctx.lineWidth = Math.max(1.5, p.size * (k > 0.35 ? 0.7 : 0.45)); ctx.lineCap = 'round';
        var tl = 0.02 + 0.035 * k;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * tl, p.y - p.vy * tl); ctx.stroke();
      } else if (p.type === 'coin') {
        var cs = p.size * (k > 0.3 ? 1 : k / 0.3); /* coins shrink away at the end instead of popping off */
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#ffd21f'; Art.circ(ctx, p.x, p.y, cs); ctx.fill();
        ctx.fillStyle = '#fff6b8'; Art.circ(ctx, p.x - cs * 0.25, p.y - cs * 0.25, cs * 0.4); ctx.fill();
      } else {
        ctx.fillStyle = p.color; Art.circ(ctx, p.x, p.y, p.size * (p.type === 'smoke' ? 1 + (1 - k) * 2 : 1)); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function outlined(str, x, y, size, fill, alpha, maxW) {
    ctx.font = 'italic 900 ' + size + 'px ' + Art.FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.globalAlpha = alpha;
    ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(3, size * 0.2);
    ctx.strokeStyle = 'rgba(6,4,18,0.92)';
    ctx.strokeText(str, x, y, maxW);
    ctx.fillStyle = fill; ctx.fillText(str, x, y, maxW);
    ctx.globalAlpha = 1;
  }

  function drawTexts(dt) {
    for (var i = texts.length - 1; i >= 0; i--) {
      var q = texts[i];
      q.life += dt;
      if (q.life >= q.max) { texts.splice(i, 1); continue; }
      var k = q.life / q.max;
      var pop = MR.reducedMotion ? 1 : 0.55 + 0.45 * outBack(Math.min(1, k / 0.16));
      outlined(q.s, MR.clamp(q.x, 0.2 * W, 0.8 * W), q.y - k * u * 1.3, q.size * pop, q.color, k > 0.7 ? (1 - k) / 0.3 : 1, W * 0.9);
    }
  }

  function drawOverlay(g, dt) {
    var i;
    /* rain */
    ctx.strokeStyle = 'rgba(170,200,255,0.2)'; ctx.lineWidth = 1;
    ctx.beginPath();
    var boost = 1 + (g.mode === 'running' ? g.speed / 12 : 0.2);
    for (i = 0; i < rain.length; i++) {
      var r = rain[i];
      r.y += r.v * dt * boost; r.x -= r.v * dt * 0.12;
      if (r.y > H + 20) { r.y = -20; r.x = Math.random() * (W + 60); }
      ctx.moveTo(r.x, r.y); ctx.lineTo(r.x + r.l * 0.12, r.y - r.l * boost);
    }
    ctx.stroke();
    /* nitro speed lines */
    if (g.nitro > 0 && g.mode === 'running') {
      ctx.strokeStyle = 'rgba(200,245,255,0.35)'; ctx.lineWidth = Math.max(1.5, 0.03 * u);
      ctx.beginPath();
      for (i = 0; i < 16; i++) {
        var lx = roadX - u + Math.random() * (roadW + 2 * u), ly = Math.random() * H, ll = (0.8 + Math.random() * 2) * u;
        ctx.moveTo(lx, ly); ctx.lineTo(lx, ly + ll);
      }
      ctx.stroke();
      ctx.fillStyle = 'rgba(33,230,255,0.05)'; ctx.fillRect(0, 0, W, H);
    }
    ctx.drawImage(vignette, 0, 0, W, H);
    if (flashHit > 0) {
      ctx.fillStyle = 'rgba(255,30,60,' + (flashHit * 0.38 * (MR.reducedMotion ? 0.5 : 1)) + ')'; ctx.fillRect(0, 0, W, H);
      flashHit = Math.max(0, flashHit - dt * 3.2);
    }
    if (flashPick > 0) {
      ctx.fillStyle = 'rgba(182,255,60,' + (flashPick * 0.1) + ')'; ctx.fillRect(0, 0, W, H);
      flashPick = Math.max(0, flashPick - dt * 4);
    }
    if (banner) {
      banner.life += dt;
      if (banner.life >= banner.max) { banner = null; return; }
      var k = banner.life / banner.max;
      var sp = bannerSpot(g.autopilot);
      var sc = MR.reducedMotion ? 1 : 0.7 + 0.3 * outBack(Math.min(1, k / 0.14));
      var al = k > 0.75 ? (1 - k) / 0.25 : Math.min(1, k / 0.06);
      var size = sp.size, subSize = size * 0.56;
      ctx.font = 'italic 900 ' + size + 'px ' + Art.FONT;
      var bw = Math.min(sp.maxW, ctx.measureText(banner.s).width);
      if (banner.sub) { ctx.font = 'italic 900 ' + subSize + 'px ' + Art.FONT; bw = Math.max(bw, Math.min(sp.maxW, ctx.measureText(banner.sub).width)); }
      var bh = size * 1.1 + (banner.sub ? subSize * 1.25 : 0);
      /* settled footprint, reported to tests; the pop-in only ever scales up to about 1.03x */
      banner.box = { zone: sp.zone, x: sp.cx - bw / 2, y: sp.cy - size * 0.55, w: bw, h: bh };
      if (sp.zone === 'gutter') Art.drawGlow(ctx, banner.color, sp.cx, sp.cy + bh * 0.25, bw * 1.5, bh * 2.2, 0.22 * al);
      outlined(banner.s, sp.cx, sp.cy, size * sc, banner.color, al, sp.maxW);
      if (banner.sub) outlined(banner.sub, sp.cx, sp.cy + size * 0.55 + subSize * 0.7, subSize * sc, '#ffffff', al, sp.maxW);
    }
  }

  /* ---------- frame ---------- */
  R.draw = function (g, dt) {
    t += dt;
    if (g.mode === 'title') idle += dt * 2.6;
    var dist = g.dist + idle;
    var accent = Art.ZONE_ACCENTS[g.level % Art.ZONE_ACCENTS.length];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#07070f'; ctx.fillRect(0, 0, W, H);
    ctx.save();
    if (punch) { punch.life += dt; if (punch.life >= punch.max) punch = null; }
    if (trauma > 0 && dt > 0) {
      /* smooth layered sines, not per frame random jitter; amplitude = trauma squared; always decays to rest */
      var amp = trauma * trauma * motion, st = t * 30;
      ctx.translate(0.16 * u * amp * (0.6 * Math.sin(st * 1.7) + 0.4 * Math.sin(st * 3.1 + 1.3)),
        0.11 * u * amp * (0.6 * Math.sin(st * 2.3 + 0.7) + 0.4 * Math.sin(st * 3.7)));
      trauma = Math.max(0, trauma - 1.7 * dt);
    }
    drawSides(dist, accent);
    drawRoad(dist, accent, g.mode === 'running' ? MR.clamp((g.speed - 5) / 10, 0, 1) : 0);
    drawStreetlights(dist);
    if (g.mode !== 'title') drawEntities(g, accent);
    drawPlayer(g);
    drawParticles(dt);
    drawTexts(dt);
    ctx.restore();
    drawOverlay(g, dt);
  };
})();

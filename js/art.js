/* Matatu Rush: procedural art. Every function draws with origin at the object's centre,
   facing up the screen, where s = pixels per lane unit. No image files anywhere. */
(function () {
  'use strict';
  var MR = window.MR;
  var Art = MR.Art = {};
  /* Barlow Condensed Black Italic is bundled in fonts/ (OFL) and declared in css/style.css */
  Art.FONT = '"Barlow Condensed", "Arial Narrow Bold", "Roboto Condensed", "Archivo Narrow", "DejaVu Sans Condensed", "Arial Black", sans-serif';
  Art.PAL = {
    pink: '#ff2d95', cyan: '#21e6ff', yellow: '#ffe14a', lime: '#b6ff3c',
    orange: '#ff8a1f', violet: '#a06bff', red: '#ff3b3b', ink: '#07070f'
  };
  Art.ZONE_ACCENTS = ['#ff2d95', '#21e6ff', '#b6ff3c', '#ff8a1f', '#a06bff', '#ffe14a', '#21e6ff'];

  function mk(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
    return c;
  }
  function rr(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  function poly(c, pts) {
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.closePath();
  }
  function circ(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); }
  Art.mk = mk; Art.rr = rr; Art.poly = poly; Art.circ = circ;

  /* tinted radial glow sprite, cached per colour */
  var glowCache = {};
  Art.glow = function (color) {
    if (glowCache[color]) return glowCache[color];
    var s = 128, c = mk(s, s), x = c.getContext('2d');
    var g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.6)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.2)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.05)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, s, s);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = color; x.fillRect(0, 0, s, s);
    glowCache[color] = c;
    return c;
  };
  Art.drawGlow = function (c, color, x, y, w, h, alpha) {
    var prev = c.globalCompositeOperation, pa = c.globalAlpha;
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = pa * alpha;
    c.drawImage(Art.glow(color), x - w / 2, y - h / 2, w, h);
    c.globalAlpha = pa;
    c.globalCompositeOperation = prev;
  };

  /* ---------- the graffiti matatu ---------- */
  Art.drawMatatu = function (c, s) {
    var w = 0.62 * s, l = 1.5 * s, x = -w / 2, y = -l / 2;
    c.fillStyle = 'rgba(0,0,0,0.5)';
    rr(c, x - 0.03 * s, y + 0.02 * s, w + 0.06 * s, l + 0.05 * s, 0.15 * s); c.fill();
    /* mirrors */
    c.fillStyle = '#ffd21f';
    c.fillRect(x - 0.06 * s, y + 0.3 * s, 0.08 * s, 0.05 * s);
    c.fillRect(x + w - 0.02 * s, y + 0.3 * s, 0.08 * s, 0.05 * s);
    /* body */
    var g = c.createLinearGradient(0, y, 0, y + l);
    g.addColorStop(0, '#ff2d95'); g.addColorStop(0.5, '#c22cff'); g.addColorStop(1, '#4b2cff');
    rr(c, x, y, w, l, 0.13 * s); c.fillStyle = g; c.fill();
    c.save(); c.clip();
    /* graffiti slashes and splats */
    c.fillStyle = '#21e6ff';
    poly(c, [[x, y + 0.6 * l], [x + w, y + 0.42 * l], [x + w, y + 0.5 * l], [x, y + 0.68 * l]]); c.fill();
    c.fillStyle = '#ffe14a';
    poly(c, [[x, y + 0.71 * l], [x + w, y + 0.53 * l], [x + w, y + 0.565 * l], [x, y + 0.745 * l]]); c.fill();
    c.fillStyle = '#b6ff3c';
    poly(c, [[x, y + 0.9 * l], [x + w, y + 0.78 * l], [x + w, y + 0.8 * l], [x, y + 0.92 * l]]); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.85)';
    var dots = [[0.18, 0.5, 0.022], [0.8, 0.62, 0.028], [0.3, 0.83, 0.02], [0.7, 0.87, 0.016], [0.5, 0.76, 0.014]];
    for (var i = 0; i < dots.length; i++) { circ(c, x + dots[i][0] * w, y + dots[i][1] * l, dots[i][2] * s); c.fill(); }
    /* yellow PSV line down both flanks */
    c.fillStyle = '#ffd21f';
    c.fillRect(x, y, 0.055 * s, l); c.fillRect(x + w - 0.055 * s, y, 0.055 * s, l);
    c.restore();
    /* bonnet highlight */
    c.fillStyle = 'rgba(255,255,255,0.18)';
    rr(c, x + 0.09 * s, y + 0.04 * s, w - 0.18 * s, 0.1 * s, 0.04 * s); c.fill();
    /* windscreen */
    c.fillStyle = '#081026';
    poly(c, [[x + 0.07 * s, y + 0.19 * s], [x + w - 0.07 * s, y + 0.19 * s], [x + w - 0.1 * s, y + 0.37 * s], [x + 0.1 * s, y + 0.37 * s]]); c.fill();
    c.fillStyle = 'rgba(120,220,255,0.55)';
    poly(c, [[x + 0.1 * s, y + 0.21 * s], [x + 0.26 * s, y + 0.21 * s], [x + 0.2 * s, y + 0.35 * s], [x + 0.12 * s, y + 0.35 * s]]); c.fill();
    /* roof panel with bolt and name */
    c.fillStyle = 'rgba(8,6,24,0.5)';
    rr(c, x + 0.1 * s, y + 0.42 * s, w - 0.2 * s, l - 0.68 * s, 0.05 * s); c.fill();
    c.fillStyle = '#ffe14a';
    poly(c, [[0.05 * s, y + 0.46 * s], [-0.08 * s, y + 0.68 * s], [0.0 * s, y + 0.68 * s], [-0.06 * s, y + 0.88 * s], [0.1 * s, y + 0.62 * s], [0.02 * s, y + 0.62 * s], [0.1 * s, y + 0.46 * s]]);
    c.fill();
    c.save();
    c.translate(0, y + 1.05 * s); c.rotate(-Math.PI / 2);
    c.font = 'italic 900 ' + (0.17 * s) + 'px ' + Art.FONT;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#fff'; c.fillText('RUSH', 0, 0.01 * s);
    c.restore();
    /* rear window */
    c.fillStyle = '#081026';
    rr(c, x + 0.1 * s, y + l - 0.2 * s, w - 0.2 * s, 0.09 * s, 0.03 * s); c.fill();
    /* lamps */
    c.fillStyle = '#fff8cf';
    rr(c, x + 0.05 * s, y + 0.012 * s, 0.15 * s, 0.06 * s, 0.025 * s); c.fill();
    rr(c, x + w - 0.2 * s, y + 0.012 * s, 0.15 * s, 0.06 * s, 0.025 * s); c.fill();
    c.fillStyle = '#ff2a2a';
    rr(c, x + 0.05 * s, y + l - 0.065 * s, 0.14 * s, 0.05 * s, 0.02 * s); c.fill();
    rr(c, x + w - 0.19 * s, y + l - 0.065 * s, 0.14 * s, 0.05 * s, 0.02 * s); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.5)'; c.lineWidth = Math.max(1, 0.014 * s);
    rr(c, x, y, w, l, 0.13 * s); c.stroke();
  };

  /* ---------- boda bodas: cruiser (passenger), weaver (solo, indicators), loader (crate) ---------- */
  var BODA = {
    cruiser: { bike: '#e02929', jacket: '#eaff2e', helmet: '#f4f4f4' },
    weaver: { bike: '#2a6bff', jacket: '#ff7a1a', helmet: '#16161e' },
    loader: { bike: '#1f9d55', jacket: '#ff4fa8', helmet: '#ffd21f' }
  };
  Art.drawBoda = function (c, s, kind) {
    var k = BODA[kind] || BODA.cruiser;
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.beginPath(); c.ellipse(0.02 * s, 0.03 * s, 0.2 * s, 0.5 * s, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#05050a';
    rr(c, -0.05 * s, -0.5 * s, 0.1 * s, 0.26 * s, 0.045 * s); c.fill();
    rr(c, -0.055 * s, 0.26 * s, 0.11 * s, 0.24 * s, 0.045 * s); c.fill();
    c.fillStyle = k.bike;
    rr(c, -0.075 * s, -0.32 * s, 0.15 * s, 0.64 * s, 0.07 * s); c.fill();
    c.strokeStyle = '#d5d9ee'; c.lineWidth = 0.035 * s; c.lineCap = 'round';
    c.beginPath(); c.moveTo(-0.19 * s, -0.25 * s); c.lineTo(0.19 * s, -0.25 * s); c.stroke();
    c.fillStyle = '#fff3b0'; circ(c, 0, -0.36 * s, 0.05 * s); c.fill();
    if (kind === 'loader') {
      c.fillStyle = '#9a6a35'; rr(c, -0.25 * s, 0.08 * s, 0.5 * s, 0.38 * s, 0.03 * s); c.fill();
      c.strokeStyle = '#5a3a18'; c.lineWidth = 0.02 * s;
      c.beginPath(); c.moveTo(-0.25 * s, 0.2 * s); c.lineTo(0.25 * s, 0.2 * s); c.moveTo(-0.25 * s, 0.34 * s); c.lineTo(0.25 * s, 0.34 * s);
      c.moveTo(0, 0.08 * s); c.lineTo(0, 0.46 * s); c.stroke();
      c.fillStyle = '#e9dcc0'; rr(c, -0.17 * s, 0.11 * s, 0.34 * s, 0.14 * s, 0.06 * s); c.fill();
    }
    if (kind === 'cruiser') {
      c.fillStyle = '#8f4dff';
      c.beginPath(); c.ellipse(0, 0.2 * s, 0.16 * s, 0.11 * s, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#1b1210'; circ(c, 0, 0.17 * s, 0.085 * s); c.fill();
    }
    c.fillStyle = k.jacket;
    c.beginPath(); c.ellipse(0, -0.02 * s, 0.18 * s, 0.125 * s, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = 0.022 * s;
    c.beginPath(); c.moveTo(-0.12 * s, 0.03 * s); c.lineTo(0.12 * s, 0.03 * s); c.stroke();
    /* arms to the bars */
    c.strokeStyle = k.jacket; c.lineWidth = 0.05 * s;
    c.beginPath(); c.moveTo(-0.14 * s, -0.05 * s); c.lineTo(-0.17 * s, -0.24 * s); c.moveTo(0.14 * s, -0.05 * s); c.lineTo(0.17 * s, -0.24 * s); c.stroke();
    c.fillStyle = k.helmet; circ(c, 0, -0.09 * s, 0.1 * s); c.fill();
    c.fillStyle = kind === 'weaver' ? '#ff2d95' : 'rgba(0,0,0,0.3)';
    c.fillRect(-0.02 * s, -0.19 * s, 0.04 * s, 0.2 * s);
    c.fillStyle = 'rgba(255,255,255,0.7)'; circ(c, -0.035 * s, -0.125 * s, 0.025 * s); c.fill();
    c.fillStyle = '#ff2a2a'; rr(c, -0.04 * s, 0.47 * s, 0.08 * s, 0.04 * s, 0.015 * s); c.fill();
  };

  /* top-down person: shoulders + head */
  Art.drawPerson = function (c, s, x, y, color, arm) {
    c.fillStyle = 'rgba(0,0,0,0.45)';
    rr(c, x - 0.125 * s, y - 0.04 * s, 0.28 * s, 0.13 * s, 0.06 * s); c.fill();
    if (arm) {
      c.strokeStyle = color; c.lineWidth = 0.05 * s; c.lineCap = 'round';
      c.beginPath(); c.moveTo(x + 0.1 * s * arm, y); c.lineTo(x + 0.19 * s * arm, y - 0.11 * s); c.stroke();
      c.fillStyle = '#8a5a3c'; circ(c, x + 0.2 * s * arm, y - 0.125 * s, 0.028 * s); c.fill();
    }
    c.fillStyle = color;
    rr(c, x - 0.14 * s, y - 0.055 * s, 0.28 * s, 0.11 * s, 0.055 * s); c.fill();
    c.fillStyle = 'rgba(0,0,0,0.22)';
    rr(c, x - 0.14 * s, y + 0.01 * s, 0.28 * s, 0.045 * s, 0.02 * s); c.fill();
    c.fillStyle = '#2a1a12'; circ(c, x, y - 0.012 * s, 0.062 * s); c.fill();
    c.fillStyle = '#8a5a3c'; circ(c, x, y - 0.035 * s, 0.034 * s); c.fill();
  };

  Art.drawCoin = function (c, s, x, y, r) {
    Art.drawGlow(c, '#ffd21f', x, y, r * 5, r * 5, 0.55);
    c.fillStyle = '#b8860b'; circ(c, x, y + r * 0.12, r); c.fill();
    c.fillStyle = '#ffd21f'; circ(c, x, y, r); c.fill();
    c.strokeStyle = '#fff3a8'; c.lineWidth = Math.max(1, r * 0.14); circ(c, x, y, r * 0.72); c.stroke();
    c.fillStyle = '#7a5200';
    c.font = '900 ' + (r * 1.15) + 'px ' + Art.FONT;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('K', x, y + r * 0.08);
  };

  /* ---------- passenger stage ---------- */
  var PAX_COLORS = ['#ff2d95', '#21e6ff', '#ffe14a', '#ff8a1f', '#b6ff3c'];
  Art.drawStage = function (c, s, e, t) {
    var w = 0.88 * s, l = 1.9 * s, x = -w / 2, y = -l / 2;
    var pulse = 0.5 + 0.5 * Math.sin(t * 6 + (e.id || 0));
    var col = e.taken ? 'rgba(182,255,60,0.25)' : '#b6ff3c';
    if (!e.taken) Art.drawGlow(c, '#b6ff3c', 0, 0, w * 2.4, l * 1.5, 0.25 + 0.15 * pulse);
    c.fillStyle = e.taken ? 'rgba(182,255,60,0.04)' : 'rgba(182,255,60,' + (0.1 + 0.08 * pulse) + ')';
    rr(c, x, y, w, l, 0.1 * s); c.fill();
    c.strokeStyle = col; c.lineWidth = Math.max(2, 0.045 * s);
    c.setLineDash([0.16 * s, 0.1 * s]); c.lineDashOffset = -t * 0.5 * s;
    rr(c, x, y, w, l, 0.1 * s); c.stroke();
    c.setLineDash([]);
    if (e.taken) return;
    /* chevrons pointing where to drive */
    c.strokeStyle = 'rgba(182,255,60,0.9)'; c.lineWidth = Math.max(2, 0.05 * s); c.lineJoin = 'round'; c.lineCap = 'round';
    for (var i = 0; i < 2; i++) {
      var cy = 0.62 * s - i * 0.22 * s - ((t * 0.5) % 0.22) * s;
      c.globalAlpha = 0.9 - i * 0.3;
      c.beginPath(); c.moveTo(-0.16 * s, cy + 0.1 * s); c.lineTo(0, cy); c.lineTo(0.16 * s, cy + 0.1 * s); c.stroke();
    }
    c.globalAlpha = 1;
    c.font = '900 ' + (0.2 * s) + 'px ' + Art.FONT;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#eaffc4';
    c.fillText('STAGE', 0, 0.12 * s);
    /* waiting passengers along both sides of the bay */
    var n = e.pax || 3;
    for (var p = 0; p < n; p++) {
      var side = p % 2 ? 1 : -1;
      var py = -0.62 * s + Math.floor(p / 2) * 0.26 * s + Math.sin(t * 7 + p * 1.7) * 0.02 * s;
      Art.drawPerson(c, s, side * 0.29 * s, py, PAX_COLORS[(p + (e.id || 0)) % PAX_COLORS.length], Math.sin(t * 9 + p) > 0 ? side : 0);
    }
    Art.drawCoin(c, s, 0, -0.2 * s + Math.sin(t * 5 + (e.id || 0)) * 0.05 * s, 0.13 * s);
  };

  /* ---------- pothole ---------- */
  Art.drawPothole = function (c, s, shape, t, accent) {
    var rng = MR.mulberry32(shape || 7), pts = [], inner = [], n = 11, i, a, r;
    for (i = 0; i < n; i++) {
      a = i / n * Math.PI * 2; r = 0.3 + rng() * 0.11;
      pts.push([Math.cos(a) * r * s * 1.12, Math.sin(a) * r * s * 0.86]);
      inner.push([Math.cos(a) * r * s * 0.72, Math.sin(a) * r * s * 0.55 + 0.02 * s]);
    }
    /* cracks */
    c.strokeStyle = 'rgba(0,0,0,0.75)'; c.lineWidth = Math.max(1, 0.022 * s); c.lineCap = 'round';
    for (i = 0; i < 5; i++) {
      a = rng() * Math.PI * 2;
      c.beginPath(); c.moveTo(Math.cos(a) * 0.3 * s, Math.sin(a) * 0.24 * s);
      c.lineTo(Math.cos(a + 0.2) * 0.47 * s, Math.sin(a + 0.2) * 0.37 * s);
      c.lineTo(Math.cos(a - 0.1) * 0.56 * s, Math.sin(a - 0.1) * 0.43 * s); c.stroke();
    }
    /* broken tarmac rim */
    poly(c, pts); c.fillStyle = '#5b4a3c'; c.fill();
    c.strokeStyle = '#c9a57a'; c.lineWidth = Math.max(1.5, 0.035 * s); c.stroke();
    c.save(); c.translate(0, 0.035 * s);
    poly(c, pts.map(function (p) { return [p[0] * 0.9, p[1] * 0.88]; })); c.fillStyle = '#120c0a'; c.fill();
    c.restore();
    /* muddy water with a neon reflection */
    poly(c, inner);
    var g = c.createLinearGradient(0, -0.2 * s, 0, 0.25 * s);
    g.addColorStop(0, '#0a1230'); g.addColorStop(1, '#27314f');
    c.fillStyle = g; c.fill();
    c.save(); c.clip();
    c.globalAlpha = 0.55 + 0.25 * Math.sin(t * 4 + (shape % 7));
    c.fillStyle = accent || '#21e6ff';
    c.fillRect(-0.16 * s, -0.02 * s, 0.32 * s, 0.035 * s);
    c.fillRect(-0.08 * s, 0.05 * s, 0.2 * s, 0.022 * s);
    c.restore();
    /* hazard pips so it reads at night */
    c.fillStyle = '#ff8a1f';
    for (i = 0; i < 3; i++) { a = -2.4 + i * 0.75; circ(c, Math.cos(a) * 0.5 * s, Math.sin(a) * 0.4 * s, 0.028 * s); c.fill(); }
  };

  /* ---------- askari checkpoint: boom, spikes, beacons, officer ---------- */
  Art.drawAskari = function (c, s, span, t, smashed) {
    var w = span * s - 0.1 * s, x = -w / 2, i;
    var flash = Math.floor(t * 5) % 2;
    /* cones leading in */
    for (i = 0; i < span + 1; i++) {
      var cx = x + (i / span) * w, cy = 0.62 * s;
      c.fillStyle = 'rgba(0,0,0,0.4)'; circ(c, cx + 0.02 * s, cy + 0.02 * s, 0.09 * s); c.fill();
      c.fillStyle = '#ff6a00'; circ(c, cx, cy, 0.085 * s); c.fill();
      c.fillStyle = '#fff'; circ(c, cx, cy, 0.05 * s); c.fill();
      c.fillStyle = '#ff6a00'; circ(c, cx, cy, 0.028 * s); c.fill();
    }
    /* spike strip */
    c.fillStyle = '#0a0a10'; c.fillRect(x, 0.16 * s, w, 0.09 * s);
    c.fillStyle = '#cfd6e6';
    var teeth = Math.round(w / (0.09 * s));
    for (i = 0; i < teeth; i++) {
      var tx = x + (i + 0.5) * (w / teeth);
      poly(c, [[tx - 0.03 * s, 0.25 * s], [tx, 0.13 * s], [tx + 0.03 * s, 0.25 * s]]); c.fill();
    }
    if (!smashed) {
      /* boom barrier, red and white */
      c.fillStyle = 'rgba(0,0,0,0.5)'; c.fillRect(x, -0.05 * s, w, 0.2 * s);
      rr(c, x, -0.1 * s, w, 0.18 * s, 0.04 * s); c.fillStyle = '#ffffff'; c.fill();
      c.save(); c.clip();
      c.fillStyle = '#e01b2f';
      var sw = 0.2 * s;
      for (var k = -1; k < w / sw + 1; k += 2) {
        poly(c, [[x + k * sw, -0.1 * s], [x + (k + 1) * sw, -0.1 * s], [x + (k + 1) * sw - 0.1 * s, 0.08 * s], [x + k * sw - 0.1 * s, 0.08 * s]]); c.fill();
      }
      c.restore();
      c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = Math.max(1, 0.018 * s); rr(c, x, -0.1 * s, w, 0.18 * s, 0.04 * s); c.stroke();
      c.fillStyle = '#10101a'; rr(c, -0.26 * s, -0.085 * s, 0.52 * s, 0.15 * s, 0.03 * s); c.fill();
      c.font = '900 ' + (0.13 * s) + 'px ' + Art.FONT;
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#fff';
      c.fillText('KANJO', 0, -0.005 * s);
    }
    /* end posts with red and blue beacons */
    var ends = [x, x + w];
    for (i = 0; i < 2; i++) {
      c.fillStyle = '#1a1a26'; rr(c, ends[i] - 0.08 * s, -0.14 * s, 0.16 * s, 0.26 * s, 0.04 * s); c.fill();
      var on = (flash === i);
      var col = i === 0 ? '#ff2a3c' : '#2f7bff';
      Art.drawGlow(c, col, ends[i], -0.01 * s, (on ? 1.6 : 0.8) * s, (on ? 1.6 : 0.8) * s, on ? 1 : 0.55);
      c.fillStyle = on ? '#fff' : col; circ(c, ends[i], -0.01 * s, 0.055 * s); c.fill();
    }
    /* the officer, hi-vis vest, waving a lit baton */
    var ax = 0, ay = -0.42 * s;
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.beginPath(); c.ellipse(ax + 0.02 * s, ay + 0.03 * s, 0.16 * s, 0.11 * s, 0, 0, Math.PI * 2); c.fill();
    var ang = -0.9 + Math.sin(t * 6) * 0.6;
    var bx = ax + 0.13 * s + Math.cos(ang) * 0.24 * s, by = ay + Math.sin(ang) * 0.24 * s;
    c.strokeStyle = '#17233f'; c.lineWidth = 0.05 * s; c.lineCap = 'round';
    c.beginPath(); c.moveTo(ax + 0.12 * s, ay); c.lineTo(ax + 0.13 * s + Math.cos(ang) * 0.1 * s, ay + Math.sin(ang) * 0.1 * s); c.stroke();
    Art.drawGlow(c, '#ff2a3c', bx, by, 0.5 * s, 0.5 * s, 0.8);
    c.strokeStyle = '#ff5a66'; c.lineWidth = 0.04 * s;
    c.beginPath(); c.moveTo(ax + 0.13 * s + Math.cos(ang) * 0.1 * s, ay + Math.sin(ang) * 0.1 * s); c.lineTo(bx, by); c.stroke();
    c.fillStyle = '#d7ff2e';
    c.beginPath(); c.ellipse(ax, ay, 0.15 * s, 0.1 * s, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#f4f6ff';
    c.fillRect(ax - 0.1 * s, ay - 0.085 * s, 0.03 * s, 0.17 * s); c.fillRect(ax + 0.07 * s, ay - 0.085 * s, 0.03 * s, 0.17 * s);
    c.fillStyle = '#17233f'; circ(c, ax, ay - 0.01 * s, 0.075 * s); c.fill();
    c.fillStyle = '#f4f4f4'; circ(c, ax, ay - 0.01 * s, 0.045 * s); c.fill();
    c.fillStyle = '#17233f'; c.fillRect(ax - 0.06 * s, ay - 0.1 * s, 0.12 * s, 0.035 * s);
  };

  /* Title icon for the kanjo checkpoint. Drawn for 38 to 56 px: a fat red and white boom, two
     glowing beacons and a hi-vis officer on a lifted backdrop, instead of the dense in-world art. */
  Art.drawAskariIcon = function (c) {
    c.fillStyle = '#2a2f58'; rr(c, -26, -26, 52, 52, 10); c.fill();
    Art.drawGlow(c, '#ff2a3c', -19, 9, 34, 34, 0.9);
    Art.drawGlow(c, '#2f7bff', 19, 9, 34, 34, 0.9);
    /* officer: lime vest, white cap, glowing baton */
    c.strokeStyle = '#ff4a5c'; c.lineWidth = 4; c.lineCap = 'round';
    Art.drawGlow(c, '#ff2a3c', 17, -19, 22, 22, 0.9);
    c.beginPath(); c.moveTo(9, -9); c.lineTo(17, -19); c.stroke();
    c.fillStyle = '#d7ff2e'; c.beginPath(); c.ellipse(0, -8, 13, 8.5, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#0b1026'; c.lineWidth = 1.5; c.stroke();
    c.fillStyle = '#f4f6ff'; c.fillRect(-9, -9.5, 18, 2.6);
    c.fillStyle = '#17233f'; circ(c, 0, -10, 6.4); c.fill();
    c.fillStyle = '#ffffff'; circ(c, 0, -10.5, 4.3); c.fill();
    c.fillStyle = '#17233f'; c.fillRect(-5.5, -17, 11, 3);
    /* boom */
    rr(c, -24, 3, 48, 12, 3); c.fillStyle = '#ffffff'; c.fill();
    c.save(); c.clip();
    c.fillStyle = '#ff1f38';
    for (var k = -1; k < 5; k += 1) { poly(c, [[-24 + k * 12, 3], [-18 + k * 12, 3], [-23 + k * 12, 15], [-29 + k * 12, 15]]); c.fill(); }
    c.restore();
    c.strokeStyle = '#0b1026'; c.lineWidth = 1.5; rr(c, -24, 3, 48, 12, 3); c.stroke();
    /* beacons */
    c.fillStyle = '#ff5a68'; circ(c, -20, 9, 5); c.fill(); c.fillStyle = '#fff'; circ(c, -20, 9, 2.4); c.fill();
    c.fillStyle = '#5aa0ff'; circ(c, 20, 9, 5); c.fill(); c.fillStyle = '#fff'; circ(c, 20, 9, 2.4); c.fill();
    /* spikes */
    c.fillStyle = '#e6ebfa';
    for (var i = 0; i < 6; i++) { poly(c, [[-21 + i * 8, 24], [-18 + i * 8, 18], [-15 + i * 8, 24]]); c.fill(); }
  };

  Art.drawRepair = function (c, s, t) {
    var b = 1 + Math.sin(t * 6) * 0.08, r = 0.3 * s * b;
    Art.drawGlow(c, '#ff5fa2', 0, 0, r * 5, r * 5, 0.7);
    c.strokeStyle = '#ffd0e4'; c.lineWidth = Math.max(2, 0.04 * s);
    circ(c, 0, 0, r * 1.25); c.stroke();
    Art.heartPath(c, 0, 0, r);
    c.fillStyle = '#ff3d8b'; c.fill();
    c.fillStyle = '#fff';
    c.fillRect(-0.03 * s, -0.13 * s, 0.06 * s, 0.22 * s); c.fillRect(-0.11 * s, -0.05 * s, 0.22 * s, 0.06 * s);
  };
  Art.heartPath = function (c, x, y, r) {
    c.beginPath();
    c.moveTo(x, y + r * 0.9);
    c.bezierCurveTo(x - r * 1.5, y - r * 0.1, x - r * 0.75, y - r * 1.15, x, y - r * 0.38);
    c.bezierCurveTo(x + r * 0.75, y - r * 1.15, x + r * 1.5, y - r * 0.1, x, y + r * 0.9);
    c.closePath();
  };

  /* ---------- sprite cache (rebuilt on resize) ---------- */
  Art.buildSprites = function (s) {
    var out = {}, c, x;
    c = mk(0.9 * s, 1.75 * s); x = c.getContext('2d'); x.translate(c.width / 2, c.height / 2); Art.drawMatatu(x, s);
    out.matatu = { img: c, w: 0.9, h: 1.75 };
    var kinds = ['cruiser', 'weaver', 'loader'];
    for (var i = 0; i < kinds.length; i++) {
      c = mk(0.7 * s, 1.2 * s); x = c.getContext('2d'); x.translate(c.width / 2, c.height / 2); Art.drawBoda(x, s, kinds[i]);
      out['boda_' + kinds[i]] = { img: c, w: 0.7, h: 1.2 };
    }
    /* headlights: a soft radial falloff, brightest at the lamps and gone by about 3 lanes ahead.
       Two overlapping lobes (one per lamp), each a radial gradient whose focus sits on the lamp
       and whose outer circle reaches forward, squeezed sideways. No wedge, no hard edge. */
    var CW = 2.6, CH = 3.5, BACK = 0.35;            /* sprite size in lane units; lamp sits BACK above the bottom */
    c = mk(CW * s, CH * s); x = c.getContext('2d');
    x.globalCompositeOperation = 'lighter';
    for (var lamp = -1; lamp <= 1; lamp += 2) {
      x.save();
      x.translate(c.width / 2 + lamp * 0.17 * s, c.height - BACK * s);
      x.rotate(lamp * 0.05);
      x.scale(0.62, 1);
      var hg = x.createRadialGradient(0, 0, 0.02 * s, 0, -1.45 * s, 1.6 * s);
      hg.addColorStop(0, 'rgba(255,246,200,0.42)');
      hg.addColorStop(0.1, 'rgba(255,243,190,0.28)');
      hg.addColorStop(0.28, 'rgba(255,240,180,0.16)');
      hg.addColorStop(0.5, 'rgba(255,238,176,0.08)');
      hg.addColorStop(0.75, 'rgba(255,236,172,0.03)');
      hg.addColorStop(1, 'rgba(255,236,172,0)');
      x.fillStyle = hg;
      x.fillRect(-3 * s, -3.2 * s, 6 * s, 3.6 * s);
      x.restore();
    }
    out.cone = { img: c, w: CW, h: CH, back: BACK, reach: 3.05 };
    return out;
  };

  /* small legend icons for the title screen */
  Art.icon = function (canvas, type) {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var size = 56;
    canvas.width = size * dpr; canvas.height = size * dpr;
    var c = canvas.getContext('2d');
    c.scale(dpr, dpr); c.translate(size / 2, size / 2);
    if (type === 'stage') { Art.drawPerson(c, 90, -13, 8, '#ff2d95', -1); Art.drawPerson(c, 90, 12, 10, '#21e6ff', 0); Art.drawCoin(c, 90, 2, -10, 11); }
    else if (type === 'boda') { Art.drawBoda(c, 46, 'cruiser'); }
    else if (type === 'pothole') { Art.drawPothole(c, 52, 4242, 1, '#21e6ff'); }
    else if (type === 'askari') { Art.drawAskariIcon(c); }
    else if (type === 'horn') {
      Art.drawGlow(c, '#21e6ff', 0, 0, 60, 60, 0.6);
      c.fillStyle = '#21e6ff'; poly(c, [[-16, -6], [-6, -6], [8, -16], [8, 16], [-6, 6], [-16, 6]]); c.fill();
      c.strokeStyle = '#ffe14a'; c.lineWidth = 3; c.lineCap = 'round';
      c.beginPath(); c.arc(8, 0, 9, -0.8, 0.8); c.stroke(); c.beginPath(); c.arc(8, 0, 16, -0.8, 0.8); c.stroke();
    }
    else if (type === 'overlap') {
      /* a matatu on the shoulder beside the road, with a dust trail */
      c.fillStyle = '#2a2f58'; rr(c, -26, -26, 52, 52, 10); c.fill();
      c.fillStyle = '#12152a'; c.fillRect(-2, -26, 28, 52);
      c.fillStyle = '#cda814'; c.fillRect(-5, -26, 3, 52);
      c.fillStyle = 'rgba(180,160,120,0.55)';
      circ(c, -15, 20, 3); c.fill(); circ(c, -11, 24, 2.2); c.fill(); circ(c, -19, 25, 2.2); c.fill();
      Art.drawGlow(c, '#b6ff3c', -15, 0, 30, 44, 0.55);
      c.fillStyle = '#b6ff3c'; rr(c, -21, -14, 12, 28, 4); c.fill();
      c.fillStyle = '#07070f'; c.fillRect(-19, -10, 8, 6);
      c.fillStyle = '#ffe14a'; c.fillRect(-19, 9, 3, 2); c.fillRect(-14, 9, 3, 2);
    }
  };
})();

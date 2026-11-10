/* Matatu Rush: core namespace, seeded RNG, safe storage, URL params. */
(function () {
  'use strict';
  var MR = window.MR = {};
  MR.VERSION = '1.0.0';
  MR.LANES = 4;

  /* Seeded PRNG (mulberry32). All gameplay randomness goes through one of these. */
  MR.mulberry32 = function (seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /* Stateless integer hash to [0,1). Used for scenery only (never gameplay). */
  MR.hash = function (n) {
    n = n | 0;
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967296;
  };

  MR.clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  MR.lerp = function (a, b, t) { return a + (b - a) * t; };

  /* URL params: ?seed=123&autopilot=1&autostart=1 */
  MR.params = (function () {
    var out = {};
    try {
      var q = (window.location.search || '').replace(/^\?/, '').split('&');
      for (var i = 0; i < q.length; i++) {
        if (!q[i]) continue;
        var kv = q[i].split('=');
        out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] === undefined ? '1' : kv[1]);
      }
    } catch (e) { /* ignore malformed query */ }
    return out;
  })();

  /* localStorage wrapper that never throws; falls back to memory. */
  MR.store = (function () {
    var mem = {};
    var ls = null;
    var ok = true;
    try {
      ls = window.localStorage;
      var probe = 'matatuRush.__probe';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
    } catch (e) {
      ls = null;
      ok = false;
    }
    return {
      isOk: function () { return ok; },
      get: function (key, def) {
        var v = null;
        try { if (ls) v = ls.getItem(key); } catch (e) { ok = false; }
        if (v === null || v === undefined) v = Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
        return (v === null || v === undefined) ? def : v;
      },
      set: function (key, value) {
        mem[key] = String(value);
        try { if (ls) ls.setItem(key, String(value)); } catch (e) { ok = false; }
      }
    };
  })();

  MR.formatKsh = function (n) {
    n = Math.max(0, Math.floor(n));
    return 'KSh ' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  MR.reducedMotion = (function () {
    try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  })();
})();

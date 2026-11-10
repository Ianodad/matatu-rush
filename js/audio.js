/* Matatu Rush: WebAudio synth. Nothing is created until init() is called from a user gesture. */
(function () {
  'use strict';
  var MR = window.MR;
  var MUTE_KEY = 'matatuRush.muted';

  var ctx = null, master, musicBus, sfxBus, comp, analyser, delay, delayGain, noiseBuf, bassDuck;
  var timer = null, nextT = 0, step = 0;
  var scratch = null;

  var A = MR.Audio = {
    created: false,
    muted: MR.store.get(MUTE_KEY, '0') === '1',
    musicOn: false,
    intensity: 0,
    nitro: false
  };

  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  A.init = function () {
    if (ctx) { if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { /* ignore */ } } return true; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { ctx = new AC(); } catch (e) { ctx = null; return false; }
    try {
      master = ctx.createGain();
      master.gain.value = A.muted ? 0 : 0.9;
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.18;
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      scratch = new Float32Array(analyser.fftSize);
      musicBus = ctx.createGain(); musicBus.gain.value = 0.5;
      sfxBus = ctx.createGain(); sfxBus.gain.value = 0.75;
      bassDuck = ctx.createGain(); bassDuck.gain.value = 1;
      delay = ctx.createDelay(1.0); delay.delayTime.value = 0.29;
      delayGain = ctx.createGain(); delayGain.gain.value = 0.32;
      delay.connect(delayGain); delayGain.connect(delay); delayGain.connect(musicBus);
      bassDuck.connect(musicBus);
      musicBus.connect(comp); sfxBus.connect(comp);
      comp.connect(master); master.connect(analyser); analyser.connect(ctx.destination);
      var len = ctx.sampleRate;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      A.created = true;
      if (ctx.state === 'suspended') ctx.resume();
    } catch (e2) {
      A.created = false;
      return false;
    }
    return true;
  };

  A.state = function () { return ctx ? ctx.state : 'none'; };

  A.setMuted = function (m) {
    A.muted = !!m;
    MR.store.set(MUTE_KEY, A.muted ? '1' : '0');
    if (ctx && master) {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(A.muted ? 0 : 0.9, ctx.currentTime, 0.015);
    }
  };

  /* RMS of what actually reaches the speakers (after master/mute). */
  A.level = function () {
    if (!ctx || !analyser) return 0;
    analyser.getFloatTimeDomainData(scratch);
    var s = 0;
    for (var i = 0; i < scratch.length; i++) s += scratch[i] * scratch[i];
    return Math.sqrt(s / scratch.length);
  };

  A.suspend = function () { if (ctx && ctx.state === 'running') { try { ctx.suspend(); } catch (e) { /* ignore */ } } };
  A.resume = function () { if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { /* ignore */ } } };

  /* ---------- voices ---------- */
  function env(g, t, a, peak, dur, rel) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.setValueAtTime(Math.max(0.0002, peak), t + Math.max(a, dur));
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a, dur) + rel);
  }
  function osc(type, freq, t, stop, dest, detune) {
    var o = ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (detune) o.detune.value = detune;
    o.connect(dest); o.start(t); o.stop(stop);
    return o;
  }
  function noise(t, dur, dest) {
    var n = ctx.createBufferSource();
    n.buffer = noiseBuf; n.loop = true;
    n.connect(dest); n.start(t, Math.random() * 0.5); n.stop(t + dur);
    return n;
  }
  function kick(t, vel) {
    var g = ctx.createGain(); g.connect(musicBus);
    var o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(155, t); o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    g.gain.setValueAtTime(vel, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    o.connect(g); o.start(t); o.stop(t + 0.28);
    bassDuck.gain.setValueAtTime(0.35, t);
    bassDuck.gain.linearRampToValueAtTime(1, t + 0.13);
  }
  function snare(t, vel) {
    var g = ctx.createGain(); g.connect(musicBus);
    var f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.9;
    f.connect(g);
    g.gain.setValueAtTime(vel, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    noise(t, 0.12, f);
    var g2 = ctx.createGain(); g2.connect(musicBus);
    g2.gain.setValueAtTime(vel * 0.5, t); g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    var o = osc('triangle', 240, t, t + 0.08, g2);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.07);
  }
  function hat(t, vel, open) {
    var g = ctx.createGain(); g.connect(musicBus);
    var f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7500;
    f.connect(g);
    var d = open ? 0.14 : 0.035;
    g.gain.setValueAtTime(vel, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    noise(t, d + 0.02, f);
  }
  function bass(t, midi, dur) {
    var g = ctx.createGain(); g.connect(bassDuck);
    var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 7;
    f.frequency.setValueAtTime(260, t);
    f.frequency.exponentialRampToValueAtTime(1500, t + 0.02);
    f.frequency.exponentialRampToValueAtTime(240, t + dur + 0.05);
    f.connect(g);
    env(g, t, 0.006, 0.55, dur, 0.06);
    var stop = t + dur + 0.1, fr = mtof(midi);
    osc('sawtooth', fr, t, stop, f, 6);
    osc('square', fr / 2, t, stop, f, -4);
    osc('sine', fr, t, stop, g);
  }
  function pluck(t, midi, vel) {
    var g = ctx.createGain(); g.connect(musicBus); g.connect(delay);
    var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(3200, t);
    f.frequency.exponentialRampToValueAtTime(700, t + 0.18); f.connect(g);
    g.gain.setValueAtTime(vel, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc('square', mtof(midi), t, t + 0.24, f, 5);
    osc('triangle', mtof(midi) * 2, t, t + 0.24, f, -5);
  }
  function stab(t, notes, vel) {
    var g = ctx.createGain(); g.connect(musicBus); g.connect(delay);
    var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1700; f.connect(g);
    g.gain.setValueAtTime(vel, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    for (var i = 0; i < notes.length; i++) osc('sawtooth', mtof(notes[i]), t, t + 0.15, f, i * 4 - 4);
  }

  /* ---------- sequencer: dembow drums + bouncing bass ---------- */
  var ROOTS = [33, 33, 29, 31];
  var BASS_A = [0, -1, -1, 0, -1, -1, 12, -1, 0, -1, 7, -1, -1, 0, -1, 10];
  var BASS_B = [0, -1, -1, 0, -1, -1, 12, -1, 0, -1, 7, -1, 12, -1, 10, 7];
  var LEAD = [
    { 0: 69, 3: 72, 6: 76, 10: 74, 12: 72 },
    { 0: 69, 3: 67, 6: 64, 10: 67, 14: 69 },
    { 0: 65, 3: 69, 6: 72, 10: 76, 12: 72 },
    { 0: 67, 3: 71, 6: 74, 8: 79, 12: 74, 14: 71 }
  ];
  var CHORDS = [[57, 60, 64], [57, 60, 64], [57, 60, 65], [55, 59, 62]];

  function playStep(s, t) {
    var st = s % 16, bar = Math.floor(s / 16) % 4, I = A.intensity;
    if (st % 4 === 0) kick(t, 0.95);
    if (st === 3 || st === 6 || st === 11 || st === 14) snare(t, (st === 6 || st === 14) ? 0.5 : 0.34);
    if (st % 4 === 2) hat(t, 0.2, st === 10);
    else if ((I >= 1 || A.nitro) && st % 2 === 1) hat(t, 0.09, false);
    if (A.nitro && st % 2 === 0) hat(t, 0.12, false);
    var pat = bar === 3 ? BASS_B : BASS_A;
    if (pat[st] >= 0) bass(t, ROOTS[bar] + 12 + pat[st], 60 / A.bpm() / 4 * (pat[st] === 0 ? 1.6 : 0.9));
    if (I >= 1 && LEAD[bar][st] !== undefined) pluck(t, LEAD[bar][st], 0.16);
    if (I >= 2 && (st === 2 || st === 10)) stab(t, CHORDS[bar], 0.1);
  }

  A.bpm = function () { return 104 + Math.min(A.intensity, 6) * 4; };

  function sched() {
    if (!ctx || !A.musicOn || ctx.state !== 'running') return;
    if (nextT < ctx.currentTime - 0.25) nextT = ctx.currentTime + 0.05;
    while (nextT < ctx.currentTime + 0.16) {
      try { playStep(step, nextT); } catch (e) { /* never let audio break the game */ }
      nextT += 60 / A.bpm() / 4;
      step++;
    }
  }

  A.startMusic = function () {
    if (!ctx) return;
    A.musicOn = true; step = 0; nextT = ctx.currentTime + 0.08;
    if (!timer) timer = setInterval(sched, 30);
  };
  A.stopMusic = function () {
    A.musicOn = false;
    if (timer) { clearInterval(timer); timer = null; }
  };

  /* ---------- sound effects ---------- */
  function sfx(fn) {
    if (!ctx || ctx.state !== 'running') return;
    try { fn(ctx.currentTime + 0.005); } catch (e) { /* ignore */ }
  }
  function tone(type, f0, f1, t, dur, vel, dest) {
    var g = ctx.createGain(); g.connect(dest || sfxBus);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    var o = osc(type, f0, t, t + dur + 0.02, g);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    return o;
  }
  function burst(t, dur, vel, type, freq, q) {
    var g = ctx.createGain(); g.connect(sfxBus);
    var f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q || 1; f.connect(g);
    g.gain.setValueAtTime(vel, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    noise(t, dur + 0.02, f);
    return f;
  }

  A.sfx = {
    lane: function () { sfx(function (t) { var f = burst(t, 0.09, 0.22, 'bandpass', 900, 1.5); f.frequency.exponentialRampToValueAtTime(2600, t + 0.08); }); },
    bump: function () { sfx(function (t) { tone('square', 110, 80, t, 0.07, 0.2); }); },
    click: function () { sfx(function (t) { tone('triangle', 660, 880, t, 0.06, 0.25); }); },
    pickup: function (combo) {
      sfx(function (t) {
        var base = 72 + Math.min(combo - 1, 8) * 2;
        tone('triangle', mtof(base), mtof(base), t, 0.09, 0.4);
        tone('triangle', mtof(base + 7), mtof(base + 7), t + 0.07, 0.16, 0.4);
        tone('sine', mtof(base + 12), mtof(base + 12), t + 0.14, 0.22, 0.25);
        burst(t, 0.05, 0.12, 'highpass', 6000);
      });
    },
    nearMiss: function () { sfx(function (t) { tone('sine', 900, 1800, t, 0.12, 0.25); }); },
    repair: function () { sfx(function (t) { tone('sine', 523, 523, t, 0.1, 0.3); tone('sine', 784, 784, t + 0.09, 0.2, 0.3); }); },
    hit: function (kind) {
      sfx(function (t) {
        tone('sine', 150, 38, t, 0.32, 0.9);
        burst(t, kind === 'pothole' ? 0.16 : 0.26, 0.55, 'lowpass', kind === 'pothole' ? 900 : 2400);
        if (kind === 'askari') {
          /* whistle trill */
          var g = ctx.createGain(); g.connect(sfxBus);
          g.gain.setValueAtTime(0.0001, t + 0.05); g.gain.exponentialRampToValueAtTime(0.3, t + 0.08);
          g.gain.setValueAtTime(0.3, t + 0.45); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
          var o = osc('sine', 2500, t + 0.05, t + 0.6, g);
          var l = ctx.createOscillator(), lg = ctx.createGain();
          l.frequency.value = 28; lg.gain.value = 260; l.connect(lg); lg.connect(o.frequency);
          l.start(t); l.stop(t + 0.6);
        }
        if (kind === 'boda') tone('square', 620, 480, t + 0.02, 0.18, 0.18);
      });
    },
    hornShort: function () { sfx(function (t) { tone('square', 392, 392, t, 0.12, 0.2); tone('square', 494, 494, t, 0.12, 0.16); }); },
    horn: function () {
      sfx(function (t) {
        /* musical matatu horn: pa pa paaa */
        var seq = [[0, 0.11, 64], [0.14, 0.11, 67], [0.28, 0.5, 71]];
        for (var i = 0; i < seq.length; i++) {
          var s = seq[i], g = ctx.createGain(), f = ctx.createBiquadFilter();
          f.type = 'bandpass'; f.frequency.value = 1300; f.Q.value = 0.7; f.connect(g); g.connect(sfxBus);
          env(g, t + s[0], 0.01, 0.5, s[1], 0.05);
          osc('square', mtof(s[2]), t + s[0], t + s[0] + s[1] + 0.1, f, 8);
          osc('sawtooth', mtof(s[2] + 4), t + s[0], t + s[0] + s[1] + 0.1, f, -8);
        }
        var w = burst(t, 1.2, 0.3, 'bandpass', 300, 1.2);
        w.frequency.exponentialRampToValueAtTime(5000, t + 1.1);
      });
    },
    smash: function () { sfx(function (t) { burst(t, 0.14, 0.4, 'bandpass', 2600, 0.8); tone('square', 300, 90, t, 0.12, 0.25); }); },
    zone: function () { sfx(function (t) { var n = [69, 73, 76, 81]; for (var i = 0; i < 4; i++) tone('triangle', mtof(n[i]), mtof(n[i]), t + i * 0.07, 0.16, 0.25); }); },
    start: function () { sfx(function (t) { tone('sawtooth', 110, 440, t, 0.35, 0.25); tone('triangle', 660, 990, t + 0.2, 0.2, 0.25); }); },
    gameOver: function () {
      sfx(function (t) {
        var n = [64, 60, 57, 52];
        for (var i = 0; i < 4; i++) tone('sawtooth', mtof(n[i]), mtof(n[i]) * 0.97, t + i * 0.19, 0.3, 0.26);
        tone('sine', 110, 40, t + 0.76, 0.8, 0.6);
      });
    },
    ready: function () { sfx(function (t) { tone('square', 523, 523, t, 0.06, 0.14); tone('square', 784, 784, t + 0.07, 0.1, 0.14); }); }
  };
})();

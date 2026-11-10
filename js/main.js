/* Matatu Rush: DOM wiring, input, main loop, event to effects mapping, read-only test API. */
(function () {
  'use strict';
  var MR = window.MR, A = MR.Audio, R = MR.Render, Art = MR.Art, C = MR.CONST;
  function $(id) { return document.getElementById(id); }

  var g = MR.createGame();
  var params = MR.params;
  var fixedSeed = (params.seed !== undefined && isFinite(parseInt(params.seed, 10))) ? (parseInt(params.seed, 10) >>> 0) : null;
  var screen = 'title';       /* 'title' | 'game' | 'pause' | 'over' */
  var acc = 0, last = 0, overAt = 0, overTimer = null, hitStop = 0;
  var hud = {};

  var el = {
    canvas: $('game'), hud: $('hud'), controls: $('controls'),
    title: $('title'), pause: $('pause'), over: $('over'),
    score: $('score'), best: $('best'), zone: $('zone'), speed: $('speed'), hearts: $('hearts'),
    combo: $('combo'), comboX: $('comboX'), comboBar: $('comboBar'), demoTag: $('demoTag'),
    horn: $('btnHorn'), hornFill: $('hornFill'), hornLbl: $('hornLbl'), live: $('live')
  };

  function announce(msg) { el.live.textContent = msg; }

  /* ---------- screens ---------- */
  function show(name) {
    screen = name;
    el.title.hidden = name !== 'title';
    el.pause.hidden = name !== 'pause';
    el.over.hidden = name !== 'over';
    if (name !== 'title') $('howto').hidden = true;
    el.hud.hidden = name === 'title';
    el.controls.hidden = !(name === 'game' || name === 'pause');
    measureHud();
    var focusEl = name === 'title' ? $('btnStart') : name === 'pause' ? $('btnResume') : name === 'over' ? $('btnAgain') : null;
    if (focusEl) { try { focusEl.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  /* tells the renderer where the HUD ends so canvas announcements can sit just under it */
  function measureHud() {
    if (el.hud.hidden) return;
    /* narrow road-side gutter: stack pause and mute so they stay off the right lane */
    var v = R.layout();
    el.hud.classList.toggle('narrow', v.w - (v.roadX + v.roadW) < 118);
    var b = Math.max(el.hud.querySelector('.hud-score').getBoundingClientRect().bottom, el.hud.querySelector('.hud-mid').getBoundingClientRect().bottom);
    el.hud.style.setProperty('--hud-b', Math.round(b) + 'px');
    var hb = b + 10;
    if (!el.demoTag.hidden) hb = Math.max(hb, el.demoTag.getBoundingClientRect().bottom + 8);
    R.setHudBottom(hb);
  }

  function refreshMuteUi() {
    var txt = A.muted ? 'Sound: Off' : 'Sound: On';
    $('btnMute').textContent = txt; $('btnMutePause').textContent = txt;
    var ids = ['btnMute', 'btnMutePause', 'btnMuteHud'];
    for (var i = 0; i < ids.length; i++) $(ids[i]).setAttribute('aria-pressed', A.muted ? 'true' : 'false');
    $('btnMuteHud').setAttribute('aria-label', A.muted ? 'Unmute sound' : 'Mute sound');
  }
  function toggleMute() {
    A.setMuted(!A.muted);
    refreshMuteUi();
    if (!A.muted) A.sfx.click();
    announce(A.muted ? 'Sound off' : 'Sound on');
  }

  function openHow() { $('howto').hidden = false; try { $('btnHowClose').focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  function closeHow() { $('howto').hidden = true; try { $('btnHow').focus({ preventScroll: true }); } catch (e) { /* ignore */ } }

  function newSeed() {
    if (fixedSeed !== null) return fixedSeed;
    return ((Date.now() & 0xffffffff) ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  }

  function startGame(autopilot, fromGesture) {
    if (overTimer) { clearTimeout(overTimer); overTimer = null; }
    if (fromGesture) { A.init(); }
    A.intensity = 0; A.nitro = false;
    if (A.created) { A.resume(); A.startMusic(); }
    R.clearFx();
    acc = 0; hitStop = 0;
    hud = {};
    g.start(newSeed(), !!autopilot);
    el.demoTag.hidden = !g.autopilot;
    show('game');
    R.banner('TWENDE!', Art.PAL.yellow, g.zoneName(0));
    announce('Game started. ' + g.zoneName(0));
  }

  function pauseGame() {
    if (g.mode !== 'running') return;
    g.mode = 'paused';
    A.suspend();
    show('pause');
    announce('Paused');
  }
  function resumeGame() {
    if (g.mode !== 'paused') return;
    g.mode = 'running';
    acc = 0;
    A.resume();
    show('game');
    announce('Resumed');
  }
  function toTitle() {
    if (overTimer) { clearTimeout(overTimer); overTimer = null; }
    A.stopMusic(); A.resume();
    g.reset(1, false);
    g.mode = 'title';
    R.clearFx();
    $('titleBest').textContent = 'Best fare: ' + MR.formatKsh(g.best);
    show('title');
  }

  function showOver(ev) {
    $('oScore').textContent = MR.formatKsh(ev.score);
    $('oBest').textContent = MR.formatKsh(ev.best);
    $('oDist').textContent = (ev.dist * 8 / 1000).toFixed(2) + ' km';
    $('oPax').textContent = String(g.stats.passengers);
    $('oCombo').textContent = 'x' + ev.bestCombo;
    $('newBest').hidden = !ev.newBest;
    $('overTag').textContent = g.autopilot ? 'Demo over. Your turn, dere!' :
      (ev.newBest ? 'Umeweza! That is a new record.' : 'Game over. The matatu needs a fundi.');
    show('over');
    announce('Game over. Fare ' + MR.formatKsh(ev.score) + '. Best ' + MR.formatKsh(ev.best) + '.');
  }

  /* ---------- game events to juice ---------- */
  /* importance tiers (trauma added per event) keep the juice proportional across the game */
  var FEEL = { small: 0.3, medium: 0.5, large: 0.8 };
  var HIT_TEXT = { pothole: 'WUEH! POTHOLE', boda: 'POLE! BODA', askari: 'KANJO!' };
  g.onEvent = function (ev) {
    switch (ev.type) {
      case 'start': A.sfx.start(); break;
      case 'lane': A.sfx.lane(); break;
      case 'bump': A.sfx.bump(); R.shake(FEEL.small); break;
      case 'pickup':
        A.sfx.pickup(ev.combo);
        R.burst(ev.lane, 0.3, '#ffd21f', 12 + Math.min(ev.combo, 6) * 2, 3.4, 'coin');
        R.ring(ev.lane, 0.2, Art.PAL.lime);
        R.flash('pick'); R.punch(0.12);
        R.text('+' + MR.formatKsh(ev.fare), ev.lane, 1.0, Art.PAL.yellow, 0.4);
        if (ev.combo === 3 || ev.combo === 5 || ev.combo === 8 || (ev.combo > 8 && ev.combo % 4 === 0)) {
          R.banner(ev.combo >= 8 ? 'NOMA SANA!' : (ev.combo >= 5 ? 'IMEWEZA!' : 'BEBA BEBA!'), Art.PAL.lime, 'x' + ev.mult + ' COMBO');
        } else {
          R.text(ev.combo > 1 ? 'BEBA! x' + ev.mult : 'BEBA!', ev.lane, 1.6, Art.PAL.lime, 0.32);
        }
        el.combo.classList.remove('pulse'); void el.combo.offsetWidth; el.combo.classList.add('pulse');
        break;
      case 'hit':
        A.sfx.hit(ev.kind);
        R.shake(FEEL.large); R.flash('hit'); R.impact(ev.px, 0.6); R.punch(-0.16);
        if (!MR.reducedMotion) hitStop = 0.08; /* brief impact freeze, real time only, once per hit */
        R.burst(ev.px, 0.6, ev.kind === 'askari' ? '#ff5a66' : '#ffb24a', 24, 4.2, 'spark');
        R.burst(ev.px, 0.4, 'rgba(200,200,220,0.5)', 8, 1.6, 'smoke');
        R.text(ev.kind === 'askari' && ev.fine ? 'KANJO! -' + MR.formatKsh(ev.fine) : HIT_TEXT[ev.kind], ev.px, 1.5, '#ff5a7a', 0.4);
        announce('Hit ' + ev.kind + '. Health ' + ev.health + ' of ' + C.MAX_HEALTH);
        break;
      case 'smash':
        A.sfx.smash(); R.shake(FEEL.small); R.impact(ev.lane, 0.6);
        R.burst(ev.lane, 0.6, Art.PAL.cyan, 14, 4, 'spark');
        R.text('+10', ev.lane, 1.2, Art.PAL.cyan, 0.3);
        break;
      case 'nearMiss':
        A.sfx.nearMiss();
        R.burst(g.px, 0.1, Art.PAL.cyan, 6, 2.4, 'spark');
        R.text('RADA! +25', g.px, 1.4, Art.PAL.cyan, 0.34);
        break;
      case 'horn':
        A.sfx.horn(); A.nitro = true;
        R.shake(FEEL.medium); R.punch(-0.1);
        R.ring(g.px, 0, Art.PAL.cyan);
        R.banner('TWENDE!', Art.PAL.cyan, 'HORN NITRO');
        announce('Horn nitro');
        break;
      case 'hornEmpty':
        A.sfx.hornShort();
        R.status('HORN CHARGING', '#aab4e0');
        break;
      case 'nitroEnd': A.nitro = false; break;
      case 'hornReady':
        A.sfx.ready();
        R.status('HORN READY!', Art.PAL.yellow);
        break;
      case 'zone':
        A.intensity = ev.level;
        A.sfx.zone();
        R.banner(ev.name, Art.ZONE_ACCENTS[ev.level % Art.ZONE_ACCENTS.length], 'SPEED UP. KAA RADA!');
        announce('Now entering ' + ev.name + '. Speed up.');
        break;
      case 'repair':
        A.sfx.repair();
        R.ring(ev.lane, 0.2, '#ff5fa2'); R.punch(0.1);
        R.burst(ev.lane, 0.3, '#ff8fc0', 8, 2.6, 'spark');
        R.text('FUNDI! +1', ev.lane, 1.3, '#ff8fc0', 0.36);
        break;
      case 'gameover':
        A.nitro = false;
        A.sfx.gameOver(); A.stopMusic();
        R.shake(1);
        overAt = performance.now();
        overTimer = setTimeout(function () { overTimer = null; showOver(ev); }, 700);
        break;
      default: break;
    }
  };

  /* ---------- HUD (DOM, updated only on change) ---------- */
  var HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21C5 15.5 2 12.2 2 8.4 2 5.4 4.3 3.2 7.1 3.2c1.9 0 3.7 1 4.9 2.7 1.2-1.7 3-2.7 4.9-2.7C19.7 3.2 22 5.4 22 8.4c0 3.8-3 7.1-10 12.6z"/></svg>';
  function setTxt(key, node, val) { if (hud[key] !== val) { hud[key] = val; node.textContent = val; return true; } return false; }

  function updateHud() {
    if (screen === 'title') return;
    if (setTxt('score', el.score, MR.formatKsh(g.score)) && hud.scoreBig !== g.stats.pickups) {
      hud.scoreBig = g.stats.pickups;
      el.score.classList.remove('bump'); void el.score.offsetWidth; el.score.classList.add('bump');
    }
    setTxt('best', el.best, 'BEST ' + MR.formatKsh(Math.max(g.best, g.autopilot ? 0 : g.score)));
    setTxt('speed', el.speed, Math.round(g.speed * 8) + ' km/h');
    if (setTxt('zone', el.zone, g.zoneName())) {
      document.documentElement.style.setProperty('--accent', Art.ZONE_ACCENTS[g.level % Art.ZONE_ACCENTS.length]);
    }
    if (hud.health !== g.health) {
      var html = '';
      for (var i = 0; i < C.MAX_HEALTH; i++) html += HEART.replace('<svg', '<svg class="' + (i < g.health ? 'on' : 'off pop') + '"');
      el.hearts.innerHTML = html;
      el.hearts.setAttribute('aria-label', 'Health ' + g.health + ' of ' + C.MAX_HEALTH);
      hud.health = g.health;
    }
    var showCombo = g.combo >= 2;
    if (hud.showCombo !== showCombo) { hud.showCombo = showCombo; el.combo.hidden = !showCombo; }
    if (showCombo) {
      setTxt('comboX', el.comboX, 'x' + Math.min(g.combo, 9));
      el.comboBar.style.transform = 'scaleX(' + MR.clamp(g.comboTimer / C.COMBO_TIME, 0, 1).toFixed(3) + ')';
    }
    var nit = g.nitro > 0, ready = g.horn >= 1 && !nit;
    var fill = nit ? g.nitro / C.NITRO_TIME : g.horn;
    el.hornFill.style.transform = 'scaleX(' + MR.clamp(fill, 0, 1).toFixed(3) + ')';
    var st = nit ? 'nitro' : (ready ? 'ready' : 'charge');
    if (hud.hornState !== st) {
      hud.hornState = st;
      el.horn.classList.toggle('ready', ready);
      el.horn.classList.toggle('nitro', nit);
      el.hornLbl.textContent = nit ? 'NITRO!' : (ready ? 'HOOT!' : 'HORN');
      el.horn.setAttribute('aria-label', nit ? 'Horn nitro active' : (ready ? 'Horn nitro ready' : 'Horn nitro charging'));
    }
  }

  /* ---------- input ---------- */
  function lateAudio() {
    /* autostart runs begin silent; the first real gesture turns sound on */
    if (!A.created && g.mode === 'running') { if (A.init()) A.startMusic(); }
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key, onBtn = e.target && e.target.tagName === 'BUTTON';
    var isGo = (k === 'Enter' || k === ' ' || e.code === 'Space');
    if (k === 'm' || k === 'M') { if (!e.repeat) toggleMute(); return; }
    if (!$('howto').hidden) { if (k === 'Escape') { closeHow(); e.preventDefault(); } return; }
    if (g.mode === 'running') {
      lateAudio();
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { if (!e.repeat) g.input('left', 'keyboard'); e.preventDefault(); return; }
      if (k === 'ArrowRight' || k === 'd' || k === 'D') { if (!e.repeat) g.input('right', 'keyboard'); e.preventDefault(); return; }
      if (k === ' ' || e.code === 'Space' || k === 'h' || k === 'H' || k === 'ArrowUp' || k === 'w' || k === 'W') {
        if (!e.repeat) g.input('horn', 'keyboard'); e.preventDefault(); return;
      }
      if (k === 'Escape' && g.autopilot) { toTitle(); e.preventDefault(); return; }
      if (k === 'p' || k === 'P' || k === 'Escape') { pauseGame(); e.preventDefault(); }
      return;
    }
    if (g.mode === 'paused') {
      if (k === 'p' || k === 'P' || k === 'Escape' || (!onBtn && isGo)) { resumeGame(); e.preventDefault(); }
      return;
    }
    if (screen === 'title') {
      if (!onBtn && isGo && !e.repeat) { startGame(false, true); e.preventDefault(); }
      return;
    }
    if (screen === 'over') {
      if (performance.now() - overAt < 600) return;
      if (k === 'Escape') { toTitle(); e.preventDefault(); return; }
      if (!e.repeat && ((!onBtn && isGo) || k === 'r' || k === 'R')) { startGame(false, true); e.preventDefault(); }
    }
  }
  function onKeyUp(e) {
    if (g.mode === 'running' && (e.key === ' ' || e.code === 'Space')) e.preventDefault();
  }

  function srcOf(e) { return (e.pointerType === 'touch' || e.pointerType === 'pen') ? 'touch' : 'mouse'; }

  function bindControl(btn, action) {
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      lateAudio();
      g.input(action, srcOf(e));
      btn.classList.add('down');
      setTimeout(function () { btn.classList.remove('down'); }, 110);
    });
    btn.addEventListener('click', function (e) {
      /* keyboard activation of a focused button (Enter) has detail 0 */
      if (e.detail === 0) g.input(action, 'keyboard');
    });
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function bindClick(id, fn) {
    $(id).addEventListener('click', function (e) {
      fn(e);
      if (e.detail > 0 && e.currentTarget.blur && screen === 'game') e.currentTarget.blur();
    });
  }

  /* ---------- loop ---------- */
  function resize() {
    var ctl = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ctl-h')) || 64;
    R.resize(ctl + 24);
    measureHud();
  }

  function frame(ts) {
    var dt = Math.min(0.1, Math.max(0, (ts - last) / 1000));
    last = ts;
    if (hitStop > 0) { hitStop -= dt; }
    else if (g.mode === 'running') {
      acc += dt;
      var n = 0;
      while (acc >= C.STEP && n < 30) { g.step(); acc -= C.STEP; n++; if (g.mode !== 'running') break; }
      if (n >= 30) acc = 0;
    }
    R.draw(g, g.mode === 'paused' ? 0 : dt);
    updateHud();
    requestAnimationFrame(frame);
  }

  /* ---------- boot ---------- */
  function boot() {
    R.init(el.canvas);
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('visibilitychange', function () { if (document.hidden) pauseGame(); });

    el.canvas.addEventListener('pointerdown', function (e) {
      if (g.mode !== 'running') return;
      e.preventDefault();
      lateAudio();
      var rect = el.canvas.getBoundingClientRect();
      g.input((e.clientX - rect.left) < rect.width / 2 ? 'left' : 'right', srcOf(e));
    });
    el.canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    bindControl($('btnLeft'), 'left');
    bindControl($('btnRight'), 'right');
    bindControl($('btnHorn'), 'horn');

    bindClick('btnStart', function () { startGame(false, true); });
    bindClick('btnDemo', function () { startGame(true, true); });
    bindClick('btnAgain', function () { if (performance.now() - overAt >= 600) startGame(false, true); });
    bindClick('btnMenu', toTitle);
    bindClick('btnPause', pauseGame);
    bindClick('btnResume', resumeGame);
    bindClick('btnQuit', toTitle);
    bindClick('btnMute', toggleMute);
    bindClick('btnMutePause', toggleMute);
    bindClick('btnMuteHud', toggleMute);
    bindClick('btnHow', openHow);
    bindClick('btnHowClose', closeHow);

    var icons = document.querySelectorAll('canvas[data-icon]');
    function drawIcons() { for (var i = 0; i < icons.length; i++) Art.icon(icons[i], icons[i].getAttribute('data-icon')); }
    drawIcons();
    /* bundled fonts: once they are in, rebuild the sprites and icons that bake text and re-measure the HUD */
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('italic 900 20px "Barlow Condensed"').then(function () { return document.fonts.ready; })
          .then(function () { resize(); drawIcons(); }, function () { /* fallback fonts are fine */ });
      }
    } catch (e) { /* ignore */ }

    refreshMuteUi();
    $('titleBest').textContent = 'Best fare: ' + MR.formatKsh(g.best);
    show('title');
    if (params.autostart) startGame(!!params.autopilot && params.autopilot !== '0', false);
    last = performance.now();
    requestAnimationFrame(frame);
  }

  /* ---------- read-only API for tests and the curious ---------- */
  window.MatatuRush = Object.freeze({
    version: MR.VERSION,
    snapshot: function () {
      var s = g.snapshot();
      s.screen = screen;
      s.fixedSeed = fixedSeed !== null;
      s.audio = {
        created: A.created, state: A.state(), muted: A.muted, musicOn: A.musicOn,
        level: Math.round(A.level() * 10000) / 10000, bpm: A.bpm(),
        steps: A.steps, fired: JSON.parse(JSON.stringify(A.fired))
      };
      s.storageOk = MR.store.isOk();
      s.view = R.layout();
      return s;
    },
    events: function (sinceSeq) { return g.events(sinceSeq); }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

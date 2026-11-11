# Matatu Rush

A neon-night Nairobi lane-weaving arcade runner. Drive a graffiti matatu up a wet four-lane road, beba passengers at stages for fare, dodge boda bodas, potholes and kanjo (askari) checkpoints, and hoot for nitro.

Fully offline: static HTML, CSS and classic scripts. No build step, no dependencies, no network, no image or audio files. All art is procedural Canvas, all sound is WebAudio synthesis. The only bundled assets are two open-licence font families in `fonts/` (see Fonts below).

## Play

Open `index.html` in a browser. Double-click it, or use a `file://` URL:

```
file:///workspace/fable-game/index.html
```

Sound starts only after you press Start (or any key or tap in a run). Best score is stored in `localStorage` on this device.

**Top 5 board.** Each device keeps its own Top 5 (`localStorage` key `matatuRush.top5`, no backend). A run that makes the board is entered at once under an alias such as `Dere 482`. The game over screen then offers a name box (Save name or Skip, Enter saves, Escape skips; leaving without touching it keeps the alias). The title has a "Top 5" button that opens the list. Demo runs never enter the board.

## Controls

| Action | Keyboard | Touch / mouse |
| --- | --- | --- |
| Switch lane | Left / Right arrows, or A / D | Tap the left or right half of the road, or the arrow buttons |
| Horn nitro (meter must be full) | Space, H, Up or W | HORN button |
| Pause / resume | P or Esc | Pause button (top right) |
| Mute | M | Speaker button, or "Sound" on the title and pause screens |
| Start / play again | Enter or Space (R also restarts) | TWENDE button |
| Back to menu from game over | Esc | Menu button |

## Rules

- **Stages** (green bays with waiting passengers): drive through to collect fare. Each pickup within 5.5 s of the last raises the combo. Fare is KSh 50 x combo (capped at x9), doubled during nitro.
- **Horn nitro**: the meter starts full, then fills from fares (about three pickups), near misses and slowly over time. Hooting gives 2.6 s of 1.65x speed, scatters bodas and smashes through anything.
- **Potholes** and **boda bodas** cost one heart. A boda with a blinking indicator is about to change lane; bodas never cut into your lane at close range.
- **Kanjo checkpoint**: a boom across two lanes. One heart and a fine of up to KSh 100.
- **Rada!** Swerving out of a lane just before an obstacle passes pays KSh 25.
- A pink heart on the road is a fundi repair (+1 heart). Three hearts; zero ends the run.
- Speed climbs continuously (44 to 100 km/h on the HUD). Every 150 lane-lengths the route changes (Tom Mboya St, Moi Avenue, Ngong Road ...) and the music adds a layer.
- Collisions use forgiving hitboxes, 1.5 s of grace after a hit, and the spawner always leaves at least one open lane.

## Files

```
index.html          page shell, HUD, title / pause / game over screens
css/style.css       layout and typography (@font-face for the bundled fonts, relative urls)
fonts/              Barlow Condensed Black Italic and Rajdhani (.ttf) with their OFL licence texts
js/core.js          namespace, seeded RNG, safe localStorage wrapper, URL params
js/game.js          deterministic 120 Hz simulation, spawner, collisions, autopilot, snapshot
js/audio.js         WebAudio synth: dembow drums, bass, lead, all sound effects
js/art.js           procedural art: matatu, bodas, stage, pothole, checkpoint, icons
js/render.js        canvas renderer, scenery, particles, screen shake
js/main.js          input, main loop, HUD updates, read-only test API
tests/run-tests.cjs Playwright end to end suite
tests/sim-balance.cjs  Node-only fairness / balance probe (no browser)
out/                test evidence (screenshots, reports, recording)
```

## Fonts

Bundled, loaded with `@font-face` from `css/style.css` through relative urls, so they work from `file://` with no network. Both are licensed under the SIL Open Font License 1.1; the licence texts ship beside them.

| Use | Family | Files | Licence |
| --- | --- | --- | --- |
| Display: logo, score, banners, popups, all canvas text (`var(--display)`, `Art.FONT`) | Barlow Condensed Black Italic | `fonts/BarlowCondensed-BlackItalic.ttf` | `fonts/OFL-BarlowCondensed.txt` |
| Body and UI (`var(--body)`) | Rajdhani Medium, SemiBold, Bold | `fonts/Rajdhani-Medium.ttf`, `fonts/Rajdhani-SemiBold.ttf`, `fonts/Rajdhani-Bold.ttf` | `fonts/OFL-Rajdhani.txt` |

If a font fails to load the game falls back to condensed system fonts. No visible UI text is set below 14 px.

## URL options (all optional)

| Param | Effect |
| --- | --- |
| `?seed=7` | Fixed seed. Every run on that page spawns the identical sequence. Without it each run gets a fresh random seed. |
| `?autopilot=1` | The built-in demo driver plays. It reads the same state a player sees and steers through the same `input()` path as the keyboard. Autopilot runs never write the best score. Also available as "Watch demo" on the title. |
| `?autostart=1` | Skip the title. Stays silent until the first real key or tap, because browsers only allow audio after a gesture. |

Difficulty is identical in every mode. Seeding only fixes the random sequence.

## Read-only state API

```js
MatatuRush.snapshot()   // deep copy: mode, seed, tick, dist, speed, score, best, health, combo,
                        // horn, player, entities, stats, input counts by source, audio, view
                        // view: road, rightLane, player and shop strip rectangles, the banner box,
                        //       floats (live popup rectangles) and slot (horn status tag)
                        // audio: state, level (output RMS), steps and fired (sfx counts by name)
MatatuRush.events(n)    // copy of the simulation event log after sequence number n
```

There are no setters. The object is frozen and returns copies.

## Tests

Requirements: Node 18+, Playwright (any recent version), Google Chrome or Playwright Chromium, and `ffmpeg` on the PATH for the recording (optional).

```
node tests/run-tests.cjs
```

The script looks for Playwright in this order: `$PLAYWRIGHT_PATH`, a normal `require('playwright')`, `./node_modules/playwright`, then the copy already on this box at `/home/box/claude-kits/vendor/herk-edit-kit/node_modules/playwright`. On another machine: `npm i -D playwright` in this folder, or set `PLAYWRIGHT_PATH`. Set `HEADED=1` to watch. Takes about 5 minutes. Exit code 0 means every check passed.

What it does (175 checks):

1. Title from `file://`, no AudioContext before a gesture, source scan for dashes and network use, inline favicon declared. The scan allows exactly one kind of `url(`: a relative link from `css/style.css` to a `.ttf` that exists in `fonts/`. It still rejects `http(s)`, `//cdn`, `@import`, `fetch`, XHR, WebSocket, `<img>`, `<audio>`, `<video>` and any other `url(`. It also checks that no font size in the CSS is below 14 px and that Impact is gone.
2. Real keyboard: Enter, arrows, A/D, kerb clamping, mute (measured as output RMS: audible, silent when muted, audible again), pause.
3. A 26 s run steered only by real key presses (seed 7): pickups, combo, score reconciled against the event log, horn nitro, speed ramp, all obstacle types seen. Also: no two floating popups overlap in any sampled frame, the horn status only appears in its gutter slot, the AudioContext stays `running`, and the sound effect counters match the event log (one pickup sound per pickup, one horn, and so on).
4. Seed 5: drives into a pothole, a boda and a checkpoint with real keys, checks hitbox overlap and hearts, game over screen (text sizes too), restart with Enter and R, best score in localStorage and after reload, corrupt stored value.
4b. Top 5 board. In Node (real `js/game.js`, fake storage): alias format, ties keep the older entry above, never more than 5, sorted high to low, a score below 5th place gets no entry, demo runs add nothing, no invented entry from an old best, bad JSON and wrong shapes read as empty, `setBoardName` rules, and the seeded RNG is untouched. In the browser: a qualifying run shows the focused name form and already has an alias entry; typing m, r and spaces does not mute, restart or leave the screen; Enter saves (trimmed, 12 chars max) and the name survives a reload in the title sheet; Escape in the box and the Skip button keep the alias; a name like `<img src=x onerror=alert(1)>` stays plain text; a low score on a full board shows no form; the title Top 5 sheet fits 320x568, 844x390, 390x844 and 1280x720 with text at 14 px or more.
5. Phone 390x844 with touch: start, buttons, road-side taps, horn, touch-only pickups, target sizes, pause, landscape.
5b. Short screens: at 320x568, 360x640, 844x390, 390x844 and 1280x720 the Start button must be fully on screen with the title un-scrolled; at 320x568 and 844x390 a tap at that position starts the run, and the announcement banner's reported rectangle must not overlap the road below the HUD strip.
5d. Layout at 320x568, 844x390, 390x844 and 1280x720: title icon row and How to play sheet fully on screen with nothing clipped and no scrolling; every visible text node at 14 px or more on the title, sheet, HUD, combo chip and pause screen; pause and mute rectangles do not touch the right lane or any tarmac; a shop strip of at least half a lane is visible on both sides; popups do not overlap; bundled fonts loaded.
5c. Seed 21, real keys: a last-moment swerve past a pothole must emit `nearMiss` (no hit on that hazard, bonus paid); after taking damage, driving into the fundi spanner must emit `repair` and restore exactly one heart. Banner placement is sampled throughout.
6. localStorage throwing on access: boot, full run, restart.
7. Seeded autopilot demo (seed 42, autostart, no gesture) twice in the browser plus a pure Node replay of `js/game.js`: all three event logs must be identical, and no AudioContext may exist.
7b. Seed 7 demo started by a real click on "Watch demo": popup audit (combo and fare visible together, HORN READY visible with pickup text, no overlaps, slot off the road and clear of the matatu), audio audit, and the recording. The picture is a CDP screencast. The sound is the game's own WebAudio output: a test-side init script also feeds whatever is connected to the destination into a MediaRecorder. System ffmpeg muxes both, and `volumedetect` must show the audio stream is not silent.
8. Contact sheet, console and network report.

The steering "bot" in the tests lives in the test file. It reads `snapshot()` and presses real keys or taps real buttons. It never writes game state.

Outputs in `out/`: `test-report.json`, `console-errors.json`, `screenshots/` (01 to 15, plus title, how-to, play and pause at each of the four layout sizes), `contact-sheet.png`, `gameplay-demo.mp4` (about 22 s, with sound). `out/gameplay.mp4` is the first 20 s of that recording with its audio kept, cut with `ffmpeg -y -i out/gameplay-demo.mp4 -t 20 out/gameplay.mp4`.

HTTP check (optional): the favicon is a 16x16 PNG inlined as a `data:` URI in `index.html`, so there is no icon file to ship and a static server is never asked for `/favicon.ico`. To verify, serve this folder with `python3 -m http.server 8766 --bind 127.0.0.1`, then run `node out/executor-qa/server-smoke.cjs` (25 s of real key presses at `/?seed=7`). It exits 0 only with zero console errors and writes `out/executor-qa/server-report.json`, whose `requests` list must not contain `favicon.ico`.

Balance probe (no browser): `node tests/sim-balance.cjs [seeds...]` runs the real simulation with the autopilot for up to 240 s per seed and prints survival, pickups and hits.

## Limitations

See `SELF-EVAL.md`. In short: verified in headless Chrome only, touch is emulated, audio is verified by signal level and a recorded track rather than by ear, and nobody has played it by hand yet.

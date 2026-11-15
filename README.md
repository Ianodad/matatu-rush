# Matatu Rush

A neon-night Nairobi lane-weaving arcade runner. Drive a graffiti matatu up a wet four-lane road, beba passengers at stages for fare, dodge boda bodas, potholes and kanjo (askari) checkpoints, and hoot for nitro.

Static HTML, CSS and classic scripts. No build step, no dependencies, no image or audio files. All art is procedural Canvas, all sound is WebAudio synthesis. The only bundled assets are two open-licence font families in `fonts/` (see Fonts below).

**Network use, exactly.** Opened from `file://` the game is fully offline: it makes no network request at all. Served over `http(s)` AND with a Firebase project filled in (see Shared Top 5 board below), it talks to exactly three Google hosts, `identitytoolkit.googleapis.com`, `securetoken.googleapis.com` and `firestore.googleapis.com`, only to read and post the shared Top 5. The project is set in `js/config.js`; with that file empty or removed the game is offline everywhere. There are no analytics, no SDK and no other host.

## Play

Open `index.html` in a browser. Double-click it, or use a `file://` URL:

```
file:///workspace/fable-game/index.html
```

Sound starts only after you press Start (or any key or tap in a run). Best score is stored in `localStorage` on this device.

**Top 5 board.** Each device keeps its own Top 5 (`localStorage` key `matatuRush.top5`); with a configured Firebase project the board is also shared across players (see Shared Top 5 board). A run that makes the board is entered at once under an alias such as `Dere 482`. The game over screen then offers a name box (Save name or Skip, Enter saves, Escape skips; leaving without touching it keeps the alias). The title has a "Top 5" button that opens the list. Demo runs never enter the board.

**Overlap.** A second power, separate from the horn. "Overlapping" is Nairobi matatu slang for leaving the road and driving along the shoulder to get past traffic. The OVERLAP meter starts empty and is charged only by passenger pickups: the first charge takes 8 pickups (0.125 each) and every later charge fills 12 percent slower than the one before (0.11 per pickup, then 0.0968, and so on). When it is full, press O, S or Down, or tap the OVERLAP button: for 4 seconds the matatu rides the shoulder on the side it was already on (from lane 0 or 1 it goes left, from lane 2 or 3 it goes right). On the shoulder nothing can hurt it and nothing can be collected (no bodas, potholes or checkpoints, no near-miss credit, no stage pickups, no fundi items); lane and horn inputs are ignored, the combo clock holds, and the matatu blinks and its bar turns red for the last 0.8 s. It then merges into the edge lane on that side with 0.9 s of grace. It cannot start during horn nitro. The demo autopilot never uses it, so seeded demos and `tests/sim-balance.cjs` behave exactly as before.

## Shared Top 5 board (optional)

Off by default. When it is on, the "Top 5" sheet and the game over list show the best score of each of the top five devices ("Top 5, all players"), and a run that makes this device's Top 5 and beats this device's best is posted. The local per-device board stays as the fallback: if the shared board cannot be read the game shows this device's list with the note "Offline. Showing this device only." Under `file://` nothing changes and no note is shown.

**What is stored and sent** (one Firestore document per device, `scores/{anonymous id}`): the display name (1 to 12 characters; the alias or the typed name), the score (a whole number), and the server time of the write. The anonymous id comes from Firebase Anonymous Auth (a random id kept in this browser's `localStorage`, key `matatuRush.auth`; no account, no email, no cookie). No other personal data is sent. Names and scores on the board are public, and the game says so on the Top 5 sheet and on the name box. A typed name that is not 1 to 12 ASCII letters, digits, space, dot, underscore or hyphen, or that contains a word on the blocklist as a whole word, is replaced by the alias (for example `Dere 482`); the game over screen then says so ("Saved as Kumar on this device. Shared board shows Dere 482."). The check is by whole word: the name is split on anything that is not a letter and only a word that equals a blocklist entry (or the entry plus `s`, `es`, `er` or `ing`) is refused, so names like Kumar, Shitote, Himalaya or Scunthorpe pass, while `69word69` and `big word` do not. Local keys used: `matatuRush.auth`, `matatuRush.pending` (one score waiting to be sent), `matatuRush.onlineBest` (last score the server accepted), `matatuRush.lastSend` (time the last write left or was answered, shared by all tabs, for the 10 s rate limit).

**Behaviour.** At game over a qualifying run is queued under its alias. Save, Skip or Escape on the name box renames the pending record and sends it; it is also sent at page load, when a run starts (fire and forget) and when you return to the menu, so a player who never touches the box is still posted under the alias. No request is ever made unless the game is on the title or game over screen (not while running, not while paused; an answer that arrives mid-run is held until the run ends). Before sending, the client checks everything the rules check (name pattern and blocklist with alias fallback, integer score in range, score not below the last accepted one). A network failure keeps the record and nothing retries in a loop. HTTP 400 drops it. HTTP 403 and 429 can also mean "written less than 10 s ago" (for example from a second tab), so the record is kept, an attempt counter is stored in it, and one retry is scheduled 11 s after the answer; the retry first reads this device's own entry back (a score already on the server that is higher, or the same with the same name, clears the record without sending); after 3 failed attempts the record is dropped. Sends are spaced at least 11 s apart, measured from the later of the request and its answer, using a time stored in `localStorage` that all tabs share. A stored send time that is later than the device clock (the clock was ahead and has been corrected, or it jumped back) is never trusted: it is read as "just sent" and rewritten, and a flush waits at most one window (11 s) before it sends, so a clock change can never lock a device out. A flush that has been busy for more than 45 s is taken for dead and a new one may start. If the refresh of the sign-in token is refused (HTTP 400, 401 or 403) the client signs up again once with a new anonymous id; the old id's row then stays on the board. If reading the device's own entry before a retry fails, that counts as one attempt and the send goes ahead anyway (the rules decide).

**Configure** (needs a Firebase project, Firestore in native mode and Anonymous sign-in enabled):

1. In `js/config.js` set `projectId` and `apiKey` to your project id and web API key (the key is public by design; restrict it to your site's referrer and to exactly three APIs in Google Cloud: Identity Toolkit API (anonymous sign-up), Token Service API (`securetoken.googleapis.com`, the refresh of the sign-in token about every hour) and Cloud Firestore API. Leaving out the Token Service API breaks posting when the first token expires).
2. In `.firebaserc` set the same project id.
3. Deploy the rules only: `firebase deploy --only firestore:rules` (`firebase.json` has no hosting section; the site itself is served by GitHub Pages or any static host).
4. Limit abuse and cost. Do not rely on Firebase Authentication's authorized domains: that list does not restrict anonymous sign-up over the REST API. Instead restrict the API key by HTTP referrer in the Google Cloud console (this only stops other websites from using your key in a browser; it is not a security boundary, anyone can send the key from a script), set a budget alert, and stay on the free Spark plan so that abuse cannot cost money (the quota simply runs out).

**Server rules** (`firestore.rules`, deny by default): only `scores` is reachable; `get` is public and `list` only with `limit <= 10` and no offset (an offset makes Firestore bill every skipped document as a read); create and update only by the owner of the document (`request.auth.uid == docId`); the document has exactly `name`, `score`, `ts`; `score` is an integer from 1 to 5,000,000; `name` matches `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,11}$` and no whole word of its lower-case form (split on non-letters) is a blocklisted word, alone or with `s`, `es`, `er`, `ing` added; `ts` must equal the server time; an update may never lower the score and must come more than 10 s after the previous write; no deletes. The blocklist exists twice (in `js/online.js` and in the rules) and a test fails if the two differ.

**What it cannot stop.** The server cannot replay a run, so a determined person can post any score up to the cap with a clean name; anonymous ids are free, so one person can create many entries and fill the five places; the blocklist is a speed bump (spaced letters, digits for letters, look-alike words and run-together words such as two words typed without a space get through, because only whole words are matched); the web API key is public. Moderate the board from the Firebase console (delete a document) if needed, set a Google Cloud budget alert, and consider Firebase App Check if abuse appears.

**Test the rules** (local emulators only; never touches a real project). The tooling is installed outside this repo, in a scratch folder (here `$SCRATCH`), never in the project:

```
mkdir -p $SCRATCH && cd $SCRATCH && npm init -y
npm i firebase-tools@14 @firebase/rules-unit-testing firebase
export NODE_PATH=$SCRATCH/node_modules
./node_modules/.bin/firebase emulators:exec --config /path/to/matatu-rush/firebase.json \
  --only firestore,auth --project demo-matatu "node /path/to/matatu-rush/tests/rules-test.cjs"
```

It needs Java 17 or newer (firebase-tools 14 runs on Java 17; version 15 asks for Java 21) and free ports 8081 (Firestore) and 9099 (Auth), as set in `firebase.json`. `tests/rules-test.cjs` is not part of `tests/run-tests.cjs`. It runs the rule cases (allow and deny, including every blocklist word in lower, upper and mixed case, with digits around it, as a separate token and with a suffix, the offset checks through REST, and real names that merely contain a listed string) and then drives the real `js/online.js` against the emulators: sign up, send, read back with `top`, refresh token, rate-limit wait, a 403 that is kept and retried, two tabs. Exit code 0 means everything passed.

## Controls

| Action | Keyboard | Touch / mouse |
| --- | --- | --- |
| Switch lane | Left / Right arrows, or A / D | Tap the left or right half of the road, or the arrow buttons |
| Horn nitro (meter must be full) | Space, H, Up or W | HORN button |
| Overlap (meter must be full, charged by pickups) | O, S or Down | OVERLAP button |
| Pause / resume | P or Esc | Pause button (top right) |
| Mute | M | Speaker button, or "Sound" on the title and pause screens |
| Start / play again | Enter or Space (R also restarts) | TWENDE button |
| Back to menu from game over | Esc | Menu button |

## Rules

- **Stages** (green bays with waiting passengers): drive through to collect fare. Each pickup within 5.5 s of the last raises the combo. Fare is KSh 50 x combo (capped at x9), doubled during nitro.
- **Horn nitro**: the meter starts full, then fills from fares (about three pickups), near misses and slowly over time. Hooting gives 2.6 s of 1.65x speed, scatters bodas and smashes through anything.
- **Overlap**: charged only by passenger pickups (8 for the first charge, 12 percent slower each time after). Fires a 4 s ride along the shoulder that ignores every hazard and collects nothing; not available during horn nitro.
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
js/online.js        shared Top 5 over the Firebase REST API (the only file that uses the network)
js/config.js        shared board project id and public web API key (empty = shared board off)
js/audio.js         WebAudio synth: dembow drums, bass, lead, all sound effects
js/art.js           procedural art: matatu, bodas, stage, pothole, checkpoint, icons
js/render.js        canvas renderer, scenery, particles, screen shake
js/main.js          input, main loop, HUD updates, read-only test API
tests/run-tests.cjs Playwright end to end suite
tests/rules-test.cjs   Firestore rules + real online client against the local emulators (separate script)
firestore.rules     server rules for the shared board (deploy with firebase deploy --only firestore:rules)
firebase.json       rules and emulator ports only (no hosting)
.firebaserc         Firebase project id
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
                        // horn, overlap {meter, ready, active, time, side, uses}, player, entities,
                        // stats, input counts by source, audio, view
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

The script looks for Playwright in this order: `$PLAYWRIGHT_PATH`, a normal `require('playwright')`, `./node_modules/playwright`, then the copy already on this box at `/home/box/claude-kits/vendor/herk-edit-kit/node_modules/playwright`. On another machine: `npm i -D playwright` in this folder, or set `PLAYWRIGHT_PATH`. Set `HEADED=1` to watch. `ONLY=online node tests/run-tests.cjs` runs just the online group (about 2 minutes, writes no report files). Takes about 9 minutes for everything; run it under `caffeinate -i` on a Mac so the machine does not sleep mid-run. Exit code 0 means every check passed.

What it does (323 checks: 242 original, 1 added static check for the three hosts, 80 in the `online` group):

1. Title from `file://`, no AudioContext before a gesture, source scan for dashes and network use, inline favicon declared. The scan allows exactly one kind of `url(`: a relative link from `css/style.css` to a `.ttf` that exists in `fonts/`. It still rejects `http(s)`, `//cdn`, `@import`, `fetch`, XHR, WebSocket, `<img>`, `<audio>`, `<video>` and any other `url(` in every file except `js/online.js`. That one file is allowed XHR and `fetch(`, but every absolute URL in it must be exactly one of the three Google origins (`https://identitytoolkit.googleapis.com`, `https://securetoken.googleapis.com`, `https://firestore.googleapis.com`) and all three must appear; WebSocket, `//cdn`, `@import`, media tags and `url(` stay rejected there too, and the dash check covers it. It also checks that no font size in the CSS is below 14 px and that Impact is gone.
2. Real keyboard: Enter, arrows, A/D, kerb clamping, mute (measured as output RMS: audible, silent when muted, audible again), pause.
3. A 26 s run steered only by real key presses (seed 7): pickups, combo, score reconciled against the event log, horn nitro, speed ramp, all obstacle types seen. Also: no two floating popups overlap in any sampled frame, the horn status only appears in its gutter slot, the AudioContext stays `running`, and the sound effect counters match the event log (one pickup sound per pickup, one horn, and so on).
4. Seed 5: drives into a pothole, a boda and a checkpoint with real keys, checks hitbox overlap and hearts, game over screen (text sizes too), restart with Enter and R, best score in localStorage and after reload, corrupt stored value.
4b. Top 5 board. In Node (real `js/game.js`, fake storage): alias format, ties keep the older entry above, never more than 5, sorted high to low, a score below 5th place gets no entry, demo runs add nothing, no invented entry from an old best, bad JSON and wrong shapes read as empty, `setBoardName` rules, and the seeded RNG is untouched. In the browser: a qualifying run shows the focused name form and already has an alias entry; typing m, r and spaces does not mute, restart or leave the screen; Enter saves (trimmed, 12 chars max) and the name survives a reload in the title sheet; Escape in the box and the Skip button keep the alias; holding Enter or Escape after saving or skipping (auto-repeat) never restarts or leaves the screen; at 844x390 the input and, after Skip, Play again are fully in view; a real demo game over (autopilot seed 101) shows no form and leaves the board untouched; a name like `<img src=x onerror=alert(1)>` stays plain text; a low score on a full board shows no form; the title Top 5 sheet fits 320x568, 844x390, 390x844 and 1280x720 with text at 14 px or more.
4c. OVERLAP in Node (real `js/game.js`, a hand-built road): the meter starts empty and near misses and time never fill it; the first charge is exactly 8 pickups and later ones need 10 and 11 (fill 0.125, 0.11, 0.0968 per pickup); not ready gives `overlapEmpty` only; no start during nitro; the horn is refused during overlap without spending its meter; a road blocked in every lane plus an askari and bodas (and point-blank hazards at the moment of leaving) costs nothing, while the same road hurts a matatu that stays on the tarmac; nothing is collected and the combo clock holds; lane inputs are ignored; lasts 4.0 s, merges into the edge lane with at least 0.89 s of grace and an obstacle waiting there cannot hurt; left side for lanes 0 and 1, right side for 2 and 3; pause and resume keep it; a boda is held back from the re-entry lane; the seeded RNG is never called; autopilot seeds 7 and 42 never use it and match score, distance, health, lane and event trace captured before the feature existed.
5. Phone 390x844 with touch: start, buttons, road-side taps, horn, touch-only pickups, target sizes, pause, landscape.
5b. Short screens: at 320x568, 360x640, 844x390, 390x844 and 1280x720 the Start button must be fully on screen with the title un-scrolled; at 320x568 and 844x390 a tap at that position starts the run, and the announcement banner's reported rectangle must not overlap the road below the HUD strip.
5d. Layout at 320x568, 844x390, 390x844 and 1280x720: title icon row and How to play sheet fully on screen with nothing clipped and no scrolling; every visible text node at 14 px or more on the title, sheet, HUD, combo chip and pause screen; pause and mute rectangles do not touch the right lane or any tarmac; a shop strip of at least half a lane is visible on both sides; popups do not overlap; bundled fonts loaded.
5e. OVERLAP in the browser: title and How to play text; the four control buttons fit (on screen, 44 px, no overlap, label not clipped) at 1280x720, 844x390, 320x568 and 390x844; at 1280x720 a real key-driven run fills the meter from pickups, O / S / ArrowDown answer `overlapEmpty` while charging, typing in a text box fires nothing, O fires it when full, Space and the lane keys are refused during it; at 844x390 (S), 320x568 (ArrowDown) and 390x844 (a tap on the button) a demo run is fired by the test; the button goes charging, ready, active (draining) and back with matching labels and aria-labels; the matatu is drawn outside the road rectangle and fully on screen; no hit, smash, near-miss or pickup during it; the banner and ready popup appear and no popup overlap regressions.
5c. Seed 21, real keys: a last-moment swerve past a pothole must emit `nearMiss` (no hit on that hazard, bonus paid); after taking damage, driving into the fundi spanner must emit `repair` and restore exactly one heart. Banner placement is sampled throughout.
6. localStorage throwing on access: boot, full run, restart.
7. Seeded autopilot demo (seed 42, autostart, no gesture) twice in the browser plus a pure Node replay of `js/game.js`: all three event logs must be identical, and no AudioContext may exist.
7b. Seed 4 demo started by a real click on "Watch demo": popup audit (combo and fare visible together, HORN READY visible with pickup text, no overlaps, slot off the road and clear of the matatu), audio audit, and the recording. The picture is a CDP screencast. The sound is the game's own WebAudio output: a test-side init script also feeds whatever is connected to the destination into a MediaRecorder. System ffmpeg muxes both, and `volumedetect` must show the audio stream is not silent.
7c. Online shared board (group `online`; the existing groups still run from `file://`, and the final network report still requires every request of every other page to be `file://`). In Node (real `js/online.js`): the blocklist equals the one in `firestore.rules`, same score cap, same name pattern, the name test, the `enabled()` gate (false under `file://`, with an empty config, or on a non-http page), zero XHR under `file://`, the pending-record rules (one record, higher score kept, only above `onlineBest`, rename), corrupt storage. In the browser, pages are served from a tiny local Node http server on 127.0.0.1 with `window.MR_ONLINE_TEST` injected and all three Google hosts answered by `page.route` mocks (no real network; any other host is refused and counted): a fully configured `file://` page makes no request; `top` request shape and parsing of a realistic `runQuery` answer, malformed rows dropped; an `<img onerror>` name shown as text; Loading, error (HTTP 500) and empty states; highlight of the player's own row and the "Your best" line; the sheet at 320x568 and 844x390; sign-up once and token reuse; the commit body (typed name, integer score, `REQUEST_TIME` transform, no mask); game over queues, Save, Skip, Play again and Menu send as described; a blocklisted or non-ASCII name sends the alias; pending survives a reload with the network down and is sent at the next boot; refresh-token use and re-sign-up after an invalid token; a 403 is kept and retried (3 attempts, then dropped), a 400 drops at once; a refresh answered 403 also signs up again once; a second flush inside the rate window is delayed by one window, and one wait only (driven by an injected clock `MR_ONLINE_TEST.now` and window `MR_ONLINE_TEST.delayMs`, so it does not depend on real 11 s waits); a rejected typed name is announced on the game over screen; no request is ever made while the mode is `running` or `paused`. Between the Node checks and the browser pages, a fake world with a shared clock, fake timers and a model of the 10 s server rule checks the pending-record logic: two tabs, a slow answer, endless 403, 429, 400, 500, the re-read before a retry (and a failed re-read that still sends and counts as an attempt), a record cleared by another tab, the pre-send checks, a clock a year ahead then corrected, a year in the past, set back in the middle of a wait, repeated flush calls during a wait, the 45 s watchdog, and refresh answered 400, 403 or 500.
8. Contact sheet, console and network report.

The steering "bot" in the tests lives in the test file. It reads `snapshot()` and presses real keys or taps real buttons. It never writes game state.

Outputs in `out/`: `test-report.json`, `console-errors.json`, `screenshots/` (01 to 15, plus title, how-to, play and pause at each of the four layout sizes), `contact-sheet.png`, `gameplay-demo.mp4` (about 22 s, with sound). `out/gameplay.mp4` is the first 20 s of that recording with its audio kept, cut with `ffmpeg -y -i out/gameplay-demo.mp4 -t 20 out/gameplay.mp4`.

HTTP check (optional): the favicon is a 16x16 PNG inlined as a `data:` URI in `index.html`, so there is no icon file to ship and a static server is never asked for `/favicon.ico`. To verify, serve this folder with `python3 -m http.server 8766 --bind 127.0.0.1`, then run `node out/executor-qa/server-smoke.cjs` (25 s of real key presses at `/?seed=7`). It exits 0 only with zero console errors and writes `out/executor-qa/server-report.json`, whose `requests` list must not contain `favicon.ico`.

Balance probe (no browser): `node tests/sim-balance.cjs [seeds...]` runs the real simulation with the autopilot for up to 240 s per seed and prints survival, pickups and hits.

## Limitations

See `SELF-EVAL.md`. In short: verified in headless Chrome only, touch is emulated, audio is verified by signal level and a recorded track rather than by ear, and nobody has played it by hand yet.

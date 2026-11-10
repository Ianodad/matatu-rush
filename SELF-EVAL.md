# SELF-EVAL: Matatu Rush

Date: 2026-11-10. Builder: Claude Fable 5.2. Rounds used: 1 build round, then fix/polish round 1 of a maximum of 2 (this update). The independent Codex review of the build scored 35/40, Ship yes (`out/CODEX-REVIEW.md`). The polished state below has **not** been re-reviewed by Codex; scores here are my own.

## Polish round 1: what changed

- **Start visible on short screens.** Below 700 px of height the Start row sits directly under the tagline. Start bottom edge: 219 of 568 px at 320x568 (was 625), 214 of 390 px at 844x390 (was 429), 229 of 640 px at 360x640. No scrolling needed. Taller layouts unchanged.
- **Banners no longer cover the road.** Combo, nitro and zone banners were up to 0.95 lane-widths tall at 27 percent of screen height. They are now a compact label in the left kerb gutter on wide screens, or a strip under the HUD on narrow ones (40 px tall at 320x568, ending about 0.5 lane-widths below the HUD), and last 1.25 s. On narrow screens that strip still covers a thin slice at the very top of the road; small floating pickup texts near the matatu are unchanged.
- **Feel.** Trauma-based shake replaces random jitter, importance tiers, squash and stretch on the matatu, eased pops, hero flash and stepped spark ramp. Reduced-motion handling extended to all of it. Details in `SKILLS-USED.md`.
- **Tests 64 to 81.** New: Start-without-scroll at five viewports, banner rectangle versus road, near-miss and repair with real keys. Simulation code (`js/game.js`) was not touched; the browser versus Node determinism check still passes.
- **Not verified:** the new feel was judged from screenshots and the autopilot recording, not by a person. Reduced-motion paths were not exercised by a test.

## Risk

Medium (per EVAL.md). Local only, no accounts, no paid APIs, nothing published, no commits.

## Must-Pass

Evidence comes from `node tests/run-tests.cjs`, last run 81/81 checks passed (single run after the polish edits) on system Google Chrome 156 (headless) from `file:///workspace/fable-game/index.html`. Full results: `out/test-report.json`. Check names below are the ones in that report.

| # | Must-Pass | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Offline static site opens file://; no network assets, keys, paid APIs, deploy or publishing | PASS | `[title] opens from file://`. `[offline] every request ... was file://`: 128 requests, 0 non-file. `[static] no URLs, fetch, XHR, image or media tags in shipped source`. Nothing was deployed, pushed or published. |
| 2 | Title, run, game over, restart loop; persisted high score; safe localStorage failure handling | PASS | `[gameover]`, `[restart]` (Enter and R, 3 hearts, clean score), `[persist]` best is max across runs, in localStorage, and on the title after reload (KSh 304). `[storage]` x4: boots, plays to game over and restarts with `localStorage` throwing on access; corrupt stored value ignored. |
| 3 | Real lane movement keyboard and touch; fare pickup and combo; all three obstacle types; progressive speed; horn nitro; fair collisions | PASS | Keyboard: arrows and A/D move one lane, clamp at kerbs, 6 lane events all `source: keyboard`. Touch: buttons and road-side taps, 4 lane events all `source: touch`. Pickups: 14 in the 26.6 s keyboard run, best combo 9, fares 50, 100, 150 ..., score 3228 reconciles exactly with the event log. Obstacles: pothole, boda and askari each hit once by steering into them with real keys; each cost exactly one heart; askari fined KSh 100. Speed: base 5.5 to 6.51 in 26 s. Horn: Space gave nitro at 1.65x speed, meter to 0, second press did nothing; HORN tap worked by touch. Fairness: all 6 hits had real hitbox overlap, no two hits within 1.5 s, 17 obstacles passed in other lanes with no damage. |
| 4 | Responsive phone UI and legible desktop UI; audio only on gesture; mute works | PASS | Phone 390x844: title fits with no scroll, controls 83x76 / 181x76 / 83x76 px, pause 44x44, score font 26 px, no horizontal overflow, landscape relayout OK. Screenshots 01 to 07. Audio: no AudioContext at title or in a 19 s autostarted demo with no gesture; created and `running` after Enter or tap. Mute: output RMS 0.39 to 0.0000 on M, back to 0.39 on unmute, stored. |
| 5 | No uncaught browser or console errors in automated play; no em dashes on-screen | PASS | `out/console-errors.json`: 0 console errors, 0 warnings, 0 page errors, 0 failed requests. No U+2014 or U+2013 in any shipped file (all on-screen text lives in those files). |
| 6 | Procedural art and synthesized WebAudio only | PASS | No image, audio, video or font files exist in the project. Art is Canvas drawing in `js/art.js` and `js/render.js` plus inline SVG icons; sound is oscillators and noise buffers in `js/audio.js`. |
| 7 | Automated 20 to 30 s input run; screenshots title, gameplay, pickup or combo, game over, mobile; tests report real events | PASS | 26.56 s keyboard run. `out/screenshots/01-title-desktop`, `02-gameplay-desktop`, `03-pickup-combo-desktop`, `04-horn-nitro-desktop`, `05-gameover-desktop`, `06-title-phone`, `07-gameplay-phone`, plus `out/contact-sheet.png`. The API is read-only (frozen object, deep copies, no setters). Browser event log for seed 42 is byte-identical across two browser runs and a Node replay of `js/game.js`, so the events are simulation output, not injected values. |
| 8 | README, SELF-EVAL and reproducible testing instructions | PASS | `README.md` (play, controls, rules, URL options, API, test steps), this file, `tests/run-tests.cjs`, `tests/sim-balance.cjs`. |

## Quality score

| Area | Max | Score | Why |
| --- | --- | --- | --- |
| Correctness | 10 | 9 | Repair and near-miss are now asserted with real keys (`[nearmiss]`, `[repair]`). One point still held back: no human has played it and there are no reaction-limited driver tests. Earlier note, now outdated: the heart repair pickup and near-miss bonus were not asserted by a dedicated check (near miss did not occur in the recorded runs). |
| Clarity / UX | 8 | 7 | Codex scored the build 6 for short-screen Start discovery and road-covering banners; both are fixed and asserted, so I put it back at 7. Title has a five-item legend with the actual art, controls for keys and touch, one consistent control bar. Not validated with a first-time human player; decorative puddles could still be mistaken for hazards by some. |
| Visual / craft | 8 | 7 | Graffiti matatu with PSV yellow line, three boda types, painted kerbs, neon shop signs in Sheng and Swahili, wet sheen, rain, headlights, particles, shake, hit-stop, dembow groove that layers up. Judged from screenshots and the recording only; the music has been measured, not listened to. |
| Robustness | 8 | 7 | Fixed 120 Hz step, clamped frame time, storage and audio wrapped, pause on tab hide, resize and rotation handled, zero errors. Only one browser engine tested. |
| Docs / handoff | 6 | 6 | Matches the Codex score; adds `SKILLS-USED.md`, 20 s `out/gameplay.mp4`, clean `out/matatu-rush.zip`. README, reports, screenshots, contact sheet, recording, balance probe. Recording is silent and shows the autopilot rather than a person. |
| **Total** | **40** | **36** | Threshold 34. Self-score after polish round 1; Codex baseline before polish was 35. |

## Ship?

Yes for a prototype handoff. All 8 Must-Pass still pass on the 81-check run. Still subject to a human play session, and the polish has not had an independent review.

## Commands

```
# play
google-chrome file:///workspace/fable-game/index.html

# full browser suite (about 2.5 min), exit code 0 = all pass
node tests/run-tests.cjs

# balance / fairness probe, no browser
node tests/sim-balance.cjs
```

## Limitations and things not done

- **Not played by a human.** All verification is automated. Feel, difficulty and fun are judged from the simulation, screenshots and a recording. Balance was tuned with the built-in autopilot: over seeds 1 to 12 it survived 103 to 240 s (two seeds hit the 240 s cap), which shows the spawner is fair but says little about how hard it is for a person, since the autopilot reacts faster than one.
- **The test "player" is a script.** Keyboard and touch tests send real key and touch events and only read state, but the decisions come from a small driver in the test file, not a person.
- **One browser.** Headless Google Chrome 156 on Linux only. Firefox, Safari and real iOS or Android devices are untested. Touch is Chrome's emulation at 390x844, not a physical phone.
- **Audio verified by signal, not by ear.** Tests prove the context starts only after a gesture, that signal reaches the output and that mute silences it. Whether the groove sounds good is unverified.
- **Recording.** Playwright's bundled ffmpeg is not installed on this box and I did not download it. `out/gameplay-demo.mp4` (about 21 s) was captured with a Chrome screencast and encoded with system ffmpeg. It is silent, shows the autopilot demo, and its frame pacing is the screencast's, not the game's real frame rate.
- **Fonts.** No font files are shipped. Headings use a system condensed stack starting with Impact. On this box that resolved to a substitute (fontconfig maps Impact to Anton), so the screenshots show that face; other machines will look slightly different.
- **Collision run variety.** In the collision test the second run happened to hit only potholes. All three obstacle types were hit in the first run.
- **Small screens in landscape** (for example 844x390) work but show only about six lane-lengths of road ahead.
- **Not done:** gamepad support, difficulty options, settings beyond mute, a leaderboard beyond one best score. No zip of `node_modules` exists because no packages were installed.
- **Codex review** has not been run by me, as instructed.

## Fix round 2 (2026-11-10): favicon correction

- **Issue:** the coordinator's HTTP smoke test (`http://127.0.0.1:8766/?seed=7`, 25 s) showed two console 404s, both from `GET /favicon.ico`. Gameplay was unaffected. The `file://` suite could not see this because Chrome does not report a missing favicon there.
- **Fix:** one `<link rel="icon">` line in `index.html` with a 16x16 PNG as an inline `data:` URI (generated procedurally, 194 characters). No new file, no network, `file://` unchanged. No game logic, art, CSS or existing test was changed.
- **Test added:** one static check in `tests/run-tests.cjs` that the inline icon is declared (82 checks, was 81).
- **Verified:** `node out/executor-qa/server-smoke.cjs` exit 0, 25.4 s, 52 inputs, 2 restarts, 0 console errors, 8 requests, none for `favicon.ico`. `node tests/run-tests.cjs` 82/82, console report clean, 0 non-file requests.
- **Score and Must-Pass:** unchanged (36/40 self-score, all Must-Pass pass, Ship yes as a prototype). Rounds: 1 build, 2 of 2 fix rounds used.
- **Not done:** Codex was not run by me this round, as instructed, so this change is unreviewed. The HTTP check covers headless Chrome only.

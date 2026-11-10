# NOTES: Matatu Rush

## Plan (single phase)
1. Simulation core (seeded, fixed step, read-only snapshot) 2. Audio synth 3. Procedural art and renderer 4. UI, input, accessibility 5. Playwright suite and evidence 6. Docs and self-eval.

## Status
- Phase 1 build complete, 2026-11-10. `node tests/run-tests.cjs`: 64/64 checks, console report clean.
- SELF-EVAL: see `SELF-EVAL.md`. All 8 Must-Pass pass, score 35/40 (threshold 34), Ship: yes as a prototype, rounds: 1 build, 0 fix.
- Codex: not run by the builder (brief says the coordinator reviews). Outcome pending.

## Decisions worth knowing
- Top-down four-lane road, one unit = one lane width, so the simulation is independent of screen size.
- Spawner guarantee: static blockers in a row plus bodas that would draw level with that row never exceed 3 of 4 lanes.
- Autopilot runs never write the best score.
- Recording uses CDP screencast plus system ffmpeg because Playwright's ffmpeg is not installed and nothing was downloaded.
- Playwright is borrowed from `/home/box/claude-kits/vendor/herk-edit-kit/node_modules/playwright`; nothing was installed.

## Fix/polish round 1 (2026-11-10)
- Scope: the two Codex UX nits (Start off screen at 320x568 and 844x390; banners over the road), feel polish, tests. `js/game.js` untouched.
- Skills actually loaded: gamedev-router, game-feel, game-ui-ux, pixelfx. Router result: custom Canvas 2D, no web-engine skill applies. See `SKILLS-USED.md`.
- `node tests/run-tests.cjs`: 81/81, run once after the edits. Console report clean.
- SELF-EVAL: 36/40 self-score, all Must-Pass pass, Ship yes as a prototype. Rounds: 1 build, 1 of 2 fix rounds used.
- Codex: not run by the builder this round, as instructed. Baseline review 35/40 pass; polish is unreviewed.
- Deliverables: `out/gameplay.mp4` (20.0 s, silent, cut from the 20.9 s demo), `out/matatu-rush.zip` (game files + README only).
- The older root `matatu-rush.zip` (05:59, includes logs and recordings) was left in place and is stale.

## Fix round 2 (2026-11-10)
- Scope: favicon only. HTTP serving logged two 404s for `/favicon.ico`; fixed with an inline `data:` PNG icon in `index.html`. No gameplay, art or CSS change.
- `node out/executor-qa/server-smoke.cjs`: exit 0, 0 console errors, no favicon request. `node tests/run-tests.cjs`: 82/82 (one static favicon check added).
- SELF-EVAL: unchanged at 36/40, all Must-Pass pass, Ship yes as a prototype. Rounds: 1 build, 2 of 2 fix rounds used.
- Codex: not run by the builder, as instructed; `out/codex-final*` untouched. Round 2 change is unreviewed.
- `out/matatu-rush.zip` rebuilt (same 9 files); `out/gameplay.mp4` re-cut from the re-recorded demo.

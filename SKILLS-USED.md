# Skills used: polish round 1 (2026-11-10)

Only skills whose local `SKILL.md` was actually loaded in this run are listed. Nothing was installed, cloned or downloaded.

| Skill | Loaded from | What it was used for |
| --- | --- | --- |
| `gamedev-router` | `/home/box/.claude/skills/gamedev-router/SKILL.md` + `references/custom-engines.md` | Engine detection and routing. |
| `game-feel` | `/home/box/.claude/skills/game-feel/SKILL.md` + `references/feedback-recipes.md` | Shake, hit-stop, easing, squash and stretch, importance tiers. |
| `game-ui-ux` | `/home/box/.claude/skills/game-ui-ux/SKILL.md` | Short-screen title layout, HUD-anchored announcements. |
| `pixelfx` | `/home/box/.claude/skills/pixelfx/SKILL.md` | Effect quality rules only (see the honest note below). |

## Router result: no web-engine skill applies

The router fingerprints engines by `package.json` dependencies (`phaser`, `pixi.js`, `three`). This project has no
`package.json`: it is dependency-free Canvas 2D with classic scripts. The router's rule for that case is "keep the
existing engine, use `references/custom-engines.md`, do not load an engine skill on a guess". So **no** `phaser-*`,
`pixijs-rendering` or `threejs-*` skill was loaded or is claimed, and there was no engine migration. Routed set:
custom-engine reference, then `game-feel` + `game-ui-ux` disciplines, plus `pixelfx` as requested.

## What was applied

### game-feel
- **Trauma shake** (`js/render.js`, `R.shake`): replaced per-frame `Math.random()` jitter (the skill's "buzzes like static" pitfall) with additive trauma 0..1, linear decay, amplitude = trauma squared, layered sines. It offsets the canvas transform only, never the simulation. It no longer jitters while paused.
- **Importance tiers** (`js/main.js`, `FEEL`): small (kerb bump, nitro smash), medium (horn), large (hit, game over).
- **Squash and stretch with overshoot** (`R.punch`): the matatu sprite squashes on pickup and repair, stretches on horn and hit, and returns to rest in 0.22 s on an ease-out-back curve. Visual only, hitbox unchanged.
- **Eased motion**: floating text and the banner pop in with ease-out-back; pickup rings expand on ease-out-quart instead of linearly.
- **Hit-stop** was already present (real-time, once per hit); kept at 0.08 s. Not added to routine events.
- **Accessibility**: `prefers-reduced-motion` scales shake to 20 percent and disables hit-stop, squash, the hero flash and pop-in scaling.

### game-ui-ux
- **Short screens** (`css/style.css`, `max-height: 700px`): the Start row moves directly under the tagline (CSS `order`), with how-to-play below it. Start, Watch demo and Sound are on screen without scrolling at 320x568, 360x640 and 844x390. Taller layouts are unchanged.
- **Announcements anchored to the HUD, not absolute screen fractions**: the banner used to sit at 27 percent of screen height across the road at up to 0.95 lane-widths tall. It is now a compact two-line label placed either in the left kerb gutter (wide screens) or in a strip directly under the measured HUD bottom (narrow screens), and lasts 1.25 s instead of 1.5 s.

### pixelfx
Honest scope: the pixelfx **library was not used**. It needs a git clone of its repository, which this run did not do
(no network installs, and the `pch` CLI and curl installer were explicitly off limits). The game is also not pixel
art. What was applied are rules from the skill's "what to look for" table, hand-coded into the existing particle code:
- "floaty, no punch": a 0.05 s white hero flash at the contact point on hits and nitro smashes; fast-in, slow-out rings.
- "smooth gradients": sparks use a hard three-step ramp (white core, colour, dim tail) and a shrinking streak instead of a linear alpha fade.
- "a one-shot that pops off": coin particles shrink away at the end of life.
- "stiff": near-miss and repair now get their own small spark bursts (6 and 8 particles) so they read as distinct events.
Particle counts stay small and the 420-particle cap is unchanged, so hazards stay readable.

## Not used
`camera-systems`, `audio-design`, `input-systems`, `performance-optimization`, any engine skill, Higgsfield, any paid or network service.

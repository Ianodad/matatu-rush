# Matatu Rush handoff (fix round 3)
Built on the box with Claude Code Fable 5.2 (`env -u ANTHROPIC_API_KEY`, model claude-fable-5-2). Independent Codex review of the full round-3 diff. No deploy, no Higgsfield, no paid APIs. `js/game.js` untouched.

art/QC.md and art/STYLE.md were lost in the earlier box restart; the QC items were taken from the coordinator brief, with art/qc stills as visual evidence.

## Outcome
Same offline Canvas 2D Nairobi arcade game, plus this round's fixes:

- Floating reward popups no longer overlap. Older labels are lifted clear; combo and fare stay two outlined lines; HORN READY! / HORN CHARGING sit in a dedicated right-gutter slot away from the matatu.
- Rooftops have height variation, ledges, water tanks and AC units (procedural Canvas only).
- Headlight cone is a soft radial falloff that fades at about 3 lanes.
- UI text is at least 14 px. Demo tag is "DEMO. Esc for menu". Portrait keeps a shop strip in frame. Pause and mute do not cover the right lane.
- Title how-to-play uses a compact icon row plus a How to play sheet; nothing clips at 320x568 or 844x390.
- Kanjo title icon contrast is higher.
- Impact replaced by bundled OFL fonts: Barlow Condensed Black Italic and Rajdhani, loaded with relative @font-face (works on file://). License files ship in fonts/.
- Audio actually plays after a gesture. out/gameplay.mp4 has an AAC stream (ffmpeg volumedetect: mean -11.8 dB, max 0 dB).

## Gates
Claude suite: 138/138, zero console/page errors, 231 file:// requests. Independent Codex reran the suite (output redirected under out/codex-round3-qa): 138/138, exit 0. Codex overall verdict: PASS. Report: out/CODEX-ROUND3.md.

## Play
Open /workspace/fable-game/index.html, or extract out/matatu-rush.zip and open index.html. Arrows/A/D steer, Space or H horn, P pause, M mute; touch buttons and road-side taps. External hosting requires Ian's OK and was not done.

## Deliverables
- out/matatu-rush.zip: shipped game (index.html, README.md, css/, js/, fonts/ including OFL texts), 15 files, byte-identical to current sources
- out/contact-sheet.png
- out/screenshots/: 01-11 original set, 12-popups-fare-combo-hornready-desktop.png, plus 20/30/40/50 title, howto, play and pause at 320x568, 844x390, 390x844 and 1280x720
- out/gameplay.mp4: exactly 20 s, h264 + AAC, cut from the 21.9 s demo; audio starts about 1 s in (after the Watch demo click)
- out/gameplay-demo.mp4: full 21.9 s audio-on recording
- out/video-frames/ and out/video-frame-sheet.png: extracted frames used for the manual popup check
- out/CODEX-ROUND3.md, out/claude-fix-3.log, out/test-report.json, out/console-errors.json

## Frame check (executor, Africa/Nairobi)
Checked out/gameplay.mp4 frames and the dedicated popup still:

- 0:04 BEBA! over +KSh 50, vertically separated, dark outlines, readable
- 0:05 BEBA! x2 over +KSh 100, clear gap
- 0:07 BEBA! x4 over +KSh 200, clear gap (this was the old 0:07 overlap case)
- 0:08 +KSh 250 readable; IMEWEZA! combo banner in the left gutter, not on the fare
- 0:12 TWENDE! / HORN NITRO banner in the left gutter, not on the matatu
- 0:17 BEBA! x2 over +KSh 100, still separated
- 0:18 HORN READY! in the right gutter, +KSh 150 on the road, BEBA BEBA! banner in the left gutter: three labels, none overlapping
- out/screenshots/12-popups-fare-combo-hornready-desktop.png: BEBA! x2, +KSh 100, +KSh 150 and HORN READY! all readable at once

Title/howto/play/pause at 320x568, 844x390, 390x844 and 1280x720 were viewed: no clipped how-to cards, shop strips visible in portrait, pause and mute stacked or placed off the tarmac.

## Caveats
Automated Chrome and emulated touch only. No human play, physical phone, Firefox or Safari listening test. Popup tests sample every 20-25 ms rather than every frame. On 320 px widths the combo chip can cover most of the left shop strip while a combo is live. Headlights are fairly faint by design. Root matatu-rush.zip is stale; use out/matatu-rush.zip only.

## Git
Local only, no push. Latest commit is recorded in the coordinator report after this file is committed.

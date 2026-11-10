# EVAL: Matatu Rush
## Risk
Medium: broken controls or flashy but unplayable prototype wastes Ian's time. Local-only, no accounts or paid APIs.
## Must-Pass (any fail rejects)
- Offline static site opens file://; no network assets, API keys, paid APIs, deploy or publishing.
- Functional title -> run -> game over -> restart loop and persisted high score, safe localStorage failure handling.
- Real lane movement keyboard and touch, passenger fare pickup/combo, all three obstacle types, progressive speed, horn/nitro and fair collisions.
- Responsive phone UI and legible desktop UI; audio begins only on user gesture and mute works.
- No uncaught browser/console errors in automated play and no em dashes on-screen.
- Procedural art and synthesized WebAudio only.
- Automated 20-30 second input run, screenshots title/gameplay/pickup-or-combo/game-over plus mobile; tests report real game events, not just injected success values.
- README, SELF-EVAL and reproducible testing instructions supplied.
## Quality score /40, threshold 34, all must-pass required
| Area | Max | Criteria |
| Correctness | 10 | Full gameplay loop, actual tested pickups/obstacles/boost/progression/high-score |
| Clarity / UX | 8 | Immediately understandable, readable fair challenge, touch and keyboard |
| Visual / craft | 8 | Distinct Nairobi neon character, coherent art, juicy audiovisual polish |
| Robustness | 8 | Responsive timing, no errors, offline and storage safe, resilient controls |
| Docs / handoff | 6 | Evidence, reproducible test/bot, controls, honest limitations |
## Reject examples
Fake test state posing as verified gameplay; missing collision/pickup logic; blank file://; inaccessible phone controls; paid assets; unhandled errors.
## Loop
Claude builds and self-scores. Independent Codex review after phase. At most two fix rounds through Claude Fable; stop if gates remain failed and report honestly.
## Return
SELF-EVAL: Risk, every Must-Pass with evidence, score breakdown /40, rounds used, Ship yes/no, commands and limitations.

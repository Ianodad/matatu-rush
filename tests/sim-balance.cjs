// Headless balance probe: runs the real simulation + autopilot in Node (no browser), many seeds.
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
function make() {
  const win = { location: { search: '' }, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } };
  win.window = win;
  const ctx = vm.createContext(win);
  for (const f of ['js/core.js', 'js/game.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx);
  return win.MR;
}
const seeds = process.argv[2] ? process.argv.slice(2).map(Number) : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const rows = [];
for (const seed of seeds) {
  const MR = make(); const g = MR.createGame();
  g.start(seed, true);
  const maxT = 240; let walls = 0;
  while (g.mode === 'running' && g.time < maxT) g.step();
  rows.push({ seed, t: +g.time.toFixed(1), dist: Math.round(g.dist), lvl: g.level, score: g.score, pk: g.stats.pickups, combo: g.stats.bestCombo, nm: g.stats.nearMiss, horns: g.stats.horns, sm: g.stats.smashed, hits: JSON.stringify(g.stats.hits), lanes: g.stats.laneChanges });
}
console.table(rows);

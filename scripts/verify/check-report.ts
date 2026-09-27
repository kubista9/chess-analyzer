// Prints the results-only Opening Report per colour over the SQLite game store and checks
// its invariants. Read-only; no engine.
//
//   npx tsx scripts/verify/check-report.ts [--time-class blitz|rapid] [--asof YYYY-MM-DD [--days N]]
//
// The window defaults to the last WINDOW_DAYS (183) days ending today (UTC); --asof pins it.
import { IMPORTED_TIME_CLASSES } from "../../shared/constants.js";
import { countGames, listGames } from "../../server/db/games.js";
import { buildOpeningReport, scorePercent } from "../../server/services/openingReport.js";
import type { PlayerColor, TimeClass } from "../../shared/types.js";
import { OWNER, argValue, openStoreReadonly, printTable, readAsofWindow } from "./_lib.js";

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
  }
}

const timeClass = argValue("time-class") as TimeClass | undefined;
if (timeClass && !(IMPORTED_TIME_CLASSES as readonly string[]).includes(timeClass)) {
  throw new Error(`--time-class must be one of ${IMPORTED_TIME_CLASSES.join(", ")}`);
}
const window = readAsofWindow();
const db = openStoreReadonly();
const games = listGames(db, OWNER, window, { timeClass });
const counts = countGames(db, OWNER, window);
const report = buildOpeningReport(games);

console.log(
  `Owner ${OWNER}: ${games.length} stored games in the window (${window.days} days to ${window.asof})` +
    (timeClass ? `, time class ${timeClass}` : `, ${counts.byTimeClass.blitz} blitz / ${counts.byTimeClass.rapid} rapid`) +
    "."
);
check(timeClass !== undefined || games.length === counts.total, `listGames returned ${games.length}, countGames ${counts.total}`);

for (const color of ["white", "black"] as PlayerColor[]) {
  const items = report.filter((item) => item.color === color);
  const colorGames = games.filter((entry) => entry.color === color);
  const wins = colorGames.filter((entry) => entry.result === "win").length;
  const draws = colorGames.filter((entry) => entry.result === "draw").length;

  console.log(
    `\nAs ${color === "white" ? "White" : "Black"}: ${colorGames.length} games, ` +
      `${wins}W ${draws}D ${colorGames.length - wins - draws}L, score ${scorePercent(wins, draws, colorGames.length).toFixed(1)}%`
  );
  printTable(
    items.map((item) => ({
      family: item.openingFamily,
      games: item.games,
      W: item.wins,
      D: item.draws,
      L: item.losses,
      "score%": Number(item.scorePct.toFixed(1))
    }))
  );

  check(
    items.reduce((sum, item) => sum + item.games, 0) === colorGames.length,
    `${color}: report games do not add up to the ${colorGames.length} games played with that colour`
  );
  check(
    timeClass !== undefined || colorGames.length === counts.byColor[color],
    `${color}: ${colorGames.length} games, but the store counts ${counts.byColor[color]}`
  );
}

const seen = new Set<string>();
for (const item of report) {
  const key = `${item.color}|${item.openingFamily}`;
  check(!seen.has(key), `duplicate item ${key}`);
  seen.add(key);
  check(item.wins + item.draws + item.losses === item.games, `${key}: W+D+L != games`);
  check(
    Math.abs(item.scorePct - scorePercent(item.wins, item.draws, item.games)) < 1e-9 && item.scorePct >= 0 && item.scorePct <= 100,
    `${key}: score% is not (W + 0.5D) / n`
  );
  check(
    Object.keys(item).sort().join(",") === "color,draws,games,losses,openingFamily,scorePct,wins",
    `${key}: unexpected fields ${Object.keys(item).join(",")}`
  );
}

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(`\nOK: ${report.length} opening items, each one colour; W+D+L = n and score% = (W + 0.5D) / n for all.`);

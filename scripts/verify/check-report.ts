// Prints the results-only Opening Report per colour over the raw games cache and checks its
// invariants. Read-only; no engine.
//
//   npx tsx scripts/verify/check-report.ts [--time-class blitz,rapid] [--asof YYYY-MM-DD [--days N]]
//
// Without --asof every cached game counts; with it, only games inside the window.
import { OWNER, argValue, isInWindow, loadRawGames, printTable, readAsofWindow } from "./_lib.js";
import { playerColorForGame } from "../../server/services/gameParser.js";
import { summarizeGame } from "../../server/services/gameSummary.js";
import { buildOpeningReport, scorePercent } from "../../server/services/openingReport.js";
import type { HistoryGameSummary, PlayerColor } from "../../shared/types.js";

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
  }
}

const timeClasses = argValue("time-class")?.split(",").map((value) => value.trim());
const window = argValue("asof") ? readAsofWindow() : null;

const rawGames = loadRawGames();
const games = rawGames
  .filter((game) => !timeClasses || timeClasses.includes(game.timeClass))
  .filter((game) => !window || isInWindow(game.endTime, window));

const summaries: HistoryGameSummary[] = [];
let unresolved = 0;
for (const game of games) {
  const color = playerColorForGame(game, OWNER);
  if (color) {
    summaries.push(summarizeGame(game, color));
  } else {
    unresolved += 1;
  }
}

const report = buildOpeningReport(summaries);

console.log(
  `Owner ${OWNER}: ${rawGames.length} cached games, ${games.length} selected` +
    (timeClasses ? ` (time class ${timeClasses.join("/")})` : "") +
    (window ? ` (window ${window.days} days to ${window.asof})` : "") +
    `, ${unresolved} not played by the owner.`
);

for (const color of ["white", "black"] as PlayerColor[]) {
  const items = report.filter((item) => item.color === color);
  const colorGames = summaries.filter((entry) => entry.color === color);
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

// npx tsx scripts/verify/verify-import.ts --asof 2026-09-26 [--days 183]
//
// Read-only check of the SQLite game store (storage/chess.db) after `npm run sync`.
// It recounts every stored raw archive month with its own filter, independently of
// server/services/gameDerive.ts, and asserts:
//   - per month: archive length == kept + sum(skipped), and the stored counters, the
//     independent recount and the rows in `games` all agree;
//   - no duplicate uuids or ids across months, and only blitz/rapid rows in `games`;
//   - no month gaps: every calendar month the window touches is stored (or Chess.com
//     does not list it, i.e. the owner played no games that month);
//   - the window counts from `games` equal the independent recount.
// It then prints a table by month and time class and compares with the golden numbers.
import { IMPORTED_TIME_CLASSES } from "../../shared/constants.js";
import { countGames } from "../../server/db/games.js";
import { lastSyncRun } from "../../server/db/syncRuns.js";
import type { SyncSummary } from "../../server/services/archiveImport.js";
import { OWNER, isInWindow, loadArchiveMonths, openStoreReadonly, printTable, readAsofWindow, type TableRow } from "./_lib.js";

const STANDARD_START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";

// Golden numbers over the plan's archive snapshot (GLOBAL.md / P2.md), for --asof 2026-09-26.
const GOLDEN = { asof: "2026-09-26", days: 183, total: 1377, blitz: 1231, rapid: 146, white: 685, black: 692 };
const GOLDEN_MONTHS: Record<string, { blitz: number; rapid: number }> = {
  "2026-07": { blitz: 289, rapid: 27 },
  "2026-08": { blitz: 163, rapid: 8 }
};

type Reason = "variant" | "custom-start" | "time-class" | "not-owner" | "duplicate" | "malformed";

interface Player {
  username?: unknown;
}

/** An independent re-implementation of the import filter (deliberately not gameDerive). */
function classify(game: Record<string, unknown>, seen: Set<string>): { reason: Reason } | { color: "white" | "black" } {
  const pgn = typeof game.pgn === "string" ? game.pgn : null;
  const url = typeof game.url === "string" ? game.url : null;
  const white = (game.white as Player | undefined)?.username;
  const black = (game.black as Player | undefined)?.username;
  if (!pgn || !url || typeof game.end_time !== "number" || typeof white !== "string" || typeof black !== "string") {
    return { reason: "malformed" };
  }
  if ((game.rules ?? "chess") !== "chess" || /^\[Variant "(?!Standard")/m.test(pgn)) {
    return { reason: "variant" };
  }
  const setup = typeof game.initial_setup === "string" ? game.initial_setup.split(" ").slice(0, 4).join(" ") : "";
  if ((setup && setup !== STANDARD_START) || /^\[SetUp "1"\]/m.test(pgn) || /^\[FEN "/m.test(pgn)) {
    return { reason: "custom-start" };
  }
  if (!(IMPORTED_TIME_CLASSES as readonly unknown[]).includes(game.time_class)) {
    return { reason: "time-class" };
  }
  const color = white.trim().toLowerCase() === OWNER ? "white" : black.trim().toLowerCase() === OWNER ? "black" : null;
  if (!color) {
    return { reason: "not-owner" };
  }
  const keys = [`url:${url.split("/").at(-1)}`, ...(typeof game.uuid === "string" ? [`uuid:${game.uuid}`] : [])];
  if (keys.some((key) => seen.has(key))) {
    return { reason: "duplicate" };
  }
  keys.forEach((key) => seen.add(key));
  return { color };
}

function monthsBetween(first: string, last: string): string[] {
  const months: string[] = [];
  for (let [year, month] = first.split("-").map(Number); `${year}-${String(month).padStart(2, "0")}` <= last; ) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    [year, month] = month === 12 ? [year + 1, 1] : [year, month + 1];
  }
  return months;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const failures: string[] = [];
const notes: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

const window = readAsofWindow();
const db = openStoreReadonly();
try {
  const months = loadArchiveMonths(db);
  const lastRun = lastSyncRun<SyncSummary>(db, OWNER, true);
  console.log(`verify-import: ${OWNER}, window ${iso(window.start)} .. ${iso(window.end)} (--asof ${window.asof}, ${window.days} days)`);
  console.log(
    `Store: ${months.length} archive month(s); last successful sync ${lastRun?.finishedAt ? new Date(lastRun.finishedAt).toISOString() : "never"}.\n`
  );

  const storedRows = new Map(
    (
      db.prepare("SELECT month, COUNT(*) AS n FROM games WHERE username = ? AND source = 'archive' GROUP BY month").all(OWNER) as {
        month: string;
        n: number;
      }[]
    ).map((row) => [row.month, row.n])
  );

  const allKeptUuids = new Map<string, string>();
  const windowCount = { total: 0, blitz: 0, rapid: 0, white: 0, black: 0 };
  const table: TableRow[] = [];
  let variantInWindowMonths = 0;

  for (const month of months) {
    const seen = new Set<string>();
    const reasons: Record<Reason, number> = { variant: 0, "custom-start": 0, "time-class": 0, "not-owner": 0, duplicate: 0, malformed: 0 };
    const kept = { blitz: 0, rapid: 0 };
    const inWindow = { blitz: 0, rapid: 0, white: 0, black: 0 };

    for (const game of month.games) {
      const verdict = classify(game, seen);
      if ("reason" in verdict) {
        reasons[verdict.reason] += 1;
        continue;
      }
      const timeClass = game.time_class as "blitz" | "rapid";
      kept[timeClass] += 1;
      const uuid = typeof game.uuid === "string" ? game.uuid : null;
      if (uuid) {
        check(!allKeptUuids.has(uuid), `duplicate uuid ${uuid} in ${allKeptUuids.get(uuid)} and ${month.month}`);
        allKeptUuids.set(uuid, month.month);
      }
      if (isInWindow(game.end_time as number, window)) {
        inWindow[timeClass] += 1;
        inWindow[verdict.color] += 1;
      }
    }

    const keptTotal = kept.blitz + kept.rapid;
    const skippedTotal = Object.values(reasons).reduce((sum, count) => sum + count, 0);
    const storedSkipped = Object.values(month.skipped ?? {}).reduce((sum, count) => sum + count, 0);
    check(month.gameCount === month.games.length, `${month.month}: game_count ${month.gameCount} != raw length ${month.games.length}`);
    check(keptTotal + skippedTotal === month.games.length, `${month.month}: recount kept + skipped != archive length`);
    check(month.keptCount !== null && month.keptCount + storedSkipped === month.games.length, `${month.month}: stored kept + skipped != archive length`);
    check(month.keptCount === keptTotal, `${month.month}: stored kept ${month.keptCount} != recount ${keptTotal}`);
    check(JSON.stringify(month.skipped) === JSON.stringify(reasons), `${month.month}: stored skip reasons ${JSON.stringify(month.skipped)} != recount ${JSON.stringify(reasons)}`);
    check((storedRows.get(month.month) ?? 0) === keptTotal, `${month.month}: ${storedRows.get(month.month) ?? 0} rows in games != recount ${keptTotal}`);

    const golden = GOLDEN_MONTHS[month.month];
    if (golden && (golden.blitz !== kept.blitz || golden.rapid !== kept.rapid)) {
      notes.push(`${month.month}: ${kept.blitz} blitz + ${kept.rapid} rapid (golden ${golden.blitz} + ${golden.rapid})`);
    }
    if (month.month >= "2026-03" && month.month <= "2026-09") {
      variantInWindowMonths += reasons.variant;
    }

    for (const key of ["total", "blitz", "rapid", "white", "black"] as const) {
      windowCount[key] += key === "total" ? inWindow.blitz + inWindow.rapid : inWindow[key];
    }

    table.push({
      month: month.month,
      archive: month.games.length,
      blitz: kept.blitz,
      rapid: kept.rapid,
      "win blitz": inWindow.blitz,
      "win rapid": inWindow.rapid,
      "win W": inWindow.white,
      "win B": inWindow.black,
      variant: reasons.variant,
      "custom": reasons["custom-start"],
      "time-cls": reasons["time-class"],
      "not-own": reasons["not-owner"],
      dup: reasons.duplicate,
      bad: reasons.malformed,
      status: month.lastStatus,
      checked: new Date(month.checkedAt).toISOString().slice(0, 16)
    });
  }

  printTable(table);

  // Whole-store invariants on the games table.
  const timeClasses = (db.prepare("SELECT DISTINCT time_class FROM games").all() as { time_class: string }[]).map((row) => row.time_class);
  check(timeClasses.every((timeClass) => (IMPORTED_TIME_CLASSES as readonly string[]).includes(timeClass)), `games holds time classes ${timeClasses.join(", ")}`);
  const dupUuids = db.prepare("SELECT uuid, COUNT(*) AS n FROM games WHERE uuid IS NOT NULL GROUP BY uuid HAVING n > 1").all();
  check(dupUuids.length === 0, `duplicate uuids in games: ${JSON.stringify(dupUuids)}`);
  const orphanPlies = db.prepare("SELECT COUNT(*) AS n FROM game_plies WHERE game_id NOT IN (SELECT id FROM games)").get() as { n: number };
  check(orphanPlies.n === 0, `${orphanPlies.n} game_plies rows without a game`);

  // Month gaps: every calendar month the window touches must be stored, unless Chess.com
  // does not list it (no games that month).
  const listed = new Set(lastRun?.summary?.listedMonths ?? []);
  const stored = new Set(months.map((month) => month.month));
  for (const month of monthsBetween(iso(window.start).slice(0, 7), iso(window.end).slice(0, 7))) {
    if (!stored.has(month)) {
      if (lastRun && !listed.has(month)) {
        notes.push(`${month}: not listed by Chess.com (no games that month)`);
      } else {
        failures.push(`${month}: month gap, the window touches it but it is not stored`);
      }
    }
  }
  const lastChecked = months.at(-1)?.checkedAt ?? 0;
  if (lastChecked < window.end * 1000) {
    notes.push(`the newest month was last validated ${new Date(lastChecked).toISOString()}, before the window end; games after that are missing until the next sync`);
  }

  // The store's own window counts must equal the independent recount.
  const storeCounts = countGames(db, OWNER, window);
  const storeFlat = {
    total: storeCounts.total,
    blitz: storeCounts.byTimeClass.blitz,
    rapid: storeCounts.byTimeClass.rapid,
    white: storeCounts.byColor.white,
    black: storeCounts.byColor.black
  };
  check(JSON.stringify(storeFlat) === JSON.stringify(windowCount), `window: games table ${JSON.stringify(storeFlat)} != recount ${JSON.stringify(windowCount)}`);

  console.log(
    `\nWindow: ${windowCount.total} games (${windowCount.blitz} blitz / ${windowCount.rapid} rapid; ${windowCount.white} White / ${windowCount.black} Black)` +
      (storeCounts.firstEndTime !== null ? `, ${iso(storeCounts.firstEndTime).slice(0, 10)} to ${iso(storeCounts.lastEndTime!).slice(0, 10)}` : "") +
      `. Variant games in 2026-03..09: ${variantInWindowMonths}.`
  );

  if (window.asof === GOLDEN.asof && window.days === GOLDEN.days) {
    const rows: TableRow[] = (["total", "blitz", "rapid", "white", "black"] as const).map((key) => ({
      count: key,
      golden: GOLDEN[key],
      store: windowCount[key],
      delta: windowCount[key] - GOLDEN[key]
    }));
    console.log("\nGolden comparison (plan snapshot of the archives, taken on 2026-09-26):");
    printTable(rows);
    const drift = Math.abs(windowCount.total - GOLDEN.total);
    if (drift > 0) {
      notes.push(
        `window total differs from the golden ${GOLDEN.total} by ${windowCount.total - GOLDEN.total}: games played on 2026-09-26 after the ` +
          `plan's snapshot (or a Chess.com fair-play removal) shift it; the per-month invariants above still hold`
      );
    }
    // More than a day's play of drift means something is wrong, not just late games.
    check(drift <= 25, `window total ${windowCount.total} is more than 25 games away from the golden ${GOLDEN.total}`);
    check(variantInWindowMonths === 3, `expected 3 variant games in 2026-03..09, found ${variantInWindowMonths}`);
  }
} finally {
  db.close();
}

for (const note of notes) {
  console.log(`NOTE: ${note}`);
}
if (failures.length) {
  for (const failure of failures) {
    console.error(`FAIL: ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("\nverify-import: all invariants OK");
}

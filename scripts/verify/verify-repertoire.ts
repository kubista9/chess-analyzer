// Seeds the repertoire in memory from the store (nothing is written) and prints the seeded lines to
// ply 10 per colour, the entries that need review, and the coverage of the window's games. Checks
// that the seed is deterministic, that no seeded owner move has a known engine loss >= 5, and, on
// the golden date, the P7 acceptance lines (1.c4 as White, 1...d5 against 1.e4 and 1.d4, the Albin
// replaced by an engine-sound sibling, 2...Nc6 rather than 2...Bc5 when that line is reached).
// Read-only (a short-lived engine only reads its version for the engine config).
//
//   npx tsx scripts/verify/verify-repertoire.ts --asof 2026-09-26
import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import { START_EPD } from "../../shared/epd.js";
import { buildFixList } from "../../shared/fixList.js";
import { rootVerdict, type EvalLookup } from "../../shared/openingAnalysis.js";
import { buildTree, formatLine, type OpeningTree, type TreeGame } from "../../shared/openingTree.js";
import { byColor, legalMove, repertoireStats, type RepEntry } from "../../shared/repertoire.js";
import { SEED_SOUND_LOSS, seedColor, seedFlags, type SeedEntry } from "../../shared/repertoireSeed.js";
import type { PlayerColor } from "../../shared/types.js";
import { engineConfigKey } from "../../server/engine/engineConfig.js";
import { ENGINE_PROTOCOL, canonicalJson } from "../../server/engine/protocol.js";
import { engineOptions } from "../../server/engine/sharedPool.js";
import { detectEngineId } from "../../server/engine/uci.js";
import { createAnalysisIndex, type EngineView } from "../../server/services/analysisIndex.js";
import { loadOpeningBook } from "../../server/services/openingBook.js";
import { DEFAULT_HALF_LIFE_BY_WINDOW, loadTreeGames } from "../../server/services/treeService.js";
import { OWNER, openStoreReadonly, printTable, readAsofWindow } from "./_lib.js";

const GOLDEN_ASOF = "2026-09-26";
const PRINT_PLY = 10;
const COLORS: PlayerColor[] = ["white", "black"];

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
  }
}

const window = readAsofWindow();
const golden = window.asof === GOLDEN_ASOF && window.days === 183;
const db = openStoreReadonly();
const book = loadOpeningBook();
const halfLifeDays = DEFAULT_HALF_LIFE_BY_WINDOW["6m"];

const built = COLORS.map((color) => {
  const games = loadTreeGames(db, OWNER, window, { color, timeClass: null });
  return { color, games, tree: buildTree(games, { color, now: window.end, halfLifeDays, book }) };
});

let engine: EngineView | null = null;
try {
  const idName = await detectEngineId(engineOptions());
  const row = db
    .prepare("SELECT id FROM engine_configs WHERE engine_version = ? AND protocol_json = ?")
    .get(engineConfigKey(idName).engineVersion, canonicalJson(ENGINE_PROTOCOL)) as { id: number } | undefined;
  engine = row ? createAnalysisIndex({ book: () => book, maxPly: OPENING_PLY_LIMIT }).view(db, row.id) : null;
} catch (error) {
  console.log(`No engine: ${error instanceof Error ? error.message : String(error)} (seeding on results only)`);
}
const lookup: EvalLookup | null = engine?.lookup ?? null;
const fix = buildFixList(built, engine ?? undefined);
const flagged = [...fix.items, ...fix.watch];

function seed(tree: OpeningTree): SeedEntry[] {
  return seedColor({ tree, lookup, flags: seedFlags(flagged, tree.color), existing: new Map() });
}

const started = performance.now();
const seeds = built.map(({ tree }) => seed(tree));
const seedMs = performance.now() - started;
const again = built.map(({ tree }) => seed(tree));
check(JSON.stringify(seeds) === JSON.stringify(again), "the same input gave a different seed");

console.log(
  `Window ${window.asof} (${window.days} days, H = ${halfLifeDays}); engine ${engine ? `config #${engine.configId}, ${engine.positions} positions` : "none"}; ` +
    `seeded in ${seedMs.toFixed(0)} ms; ${fix.items.length} leaks and ${fix.watch.length} watch lines as flags.`
);

/** The entry reached by UCI moves from the start, following the games' EPDs. */
function entryAt(entries: Map<string, SeedEntry>, ucis: string[]): SeedEntry | undefined {
  let epd = START_EPD;
  for (const uci of ucis) {
    const next = legalMove(epd, { uci });
    if (!next) {
      return undefined;
    }
    epd = next.toEpd;
  }
  return entries.get(epd);
}

for (const [index, { color, games, tree }] of built.entries()) {
  const entries = seeds[index];
  const map = new Map(entries.map((entry) => [entry.epd, entry]));
  console.log(`\n=== ${color}: ${entries.length} entries from ${games.length} games (${entries.filter((e) => e.status === "needs-review").length} need review)`);

  // The seeded lines to PRINT_PLY: owner moves from the seed, opponent replies from the tree.
  const lines: { line: string; n: number }[] = [];
  const walk = (epd: string, sans: string[], n: number, seen: Set<string>) => {
    const ply = sans.length;
    const ownerToMove = (epd.split(" ")[1] === "w") === (color === "white");
    if (ply >= PRINT_PLY || seen.has(epd)) {
      lines.push({ line: formatLine(sans), n });
      return;
    }
    const next = new Set(seen).add(epd);
    if (ownerToMove) {
      const entry = map.get(epd);
      const moved = entry && legalMove(epd, { uci: entry.uci });
      if (!entry || !moved) {
        lines.push({ line: `${formatLine(sans)}${sans.length ? " " : ""}(no entry)`, n });
        return;
      }
      const edge = tree.nodes.get(epd)?.edges.find((candidate) => candidate.uci === entry.uci);
      const tag = entry.replaced ? `[${entry.san} for ${entry.replaced.san}]` : entry.san;
      walk(moved.toEpd, [...sans, entry.status === "needs-review" ? `${tag}?` : tag], edge?.n ?? 0, next);
      return;
    }
    const node = tree.nodes.get(epd);
    const replies = (node?.edges ?? []).filter((edge) => edge.n >= 5);
    if (!replies.length) {
      lines.push({ line: formatLine(sans), n });
      return;
    }
    for (const edge of replies) {
      walk(edge.toEpd, [...sans, edge.san], edge.n, next);
    }
  };
  walk(START_EPD, [], games.length, new Set());
  console.log(`Seeded lines to ply ${PRINT_PLY} (opponent replies with 5+ games; ? = needs review, [X for Y] = replaces Y):`);
  printTable(lines.slice(0, 40).map(({ line, n }) => ({ n, line })));
  if (lines.length > 40) {
    console.log(`... ${lines.length - 40} more lines`);
  }

  const review = entries.filter((entry) => entry.status === "needs-review");
  console.log(`\nNeeds review (${review.length}), first 15 by ply:`);
  printTable(
    review.slice(0, 15).map((entry) => ({
      ply: entry.ply,
      move: entry.san,
      source: entry.source,
      replaces: entry.replaced?.san ?? "",
      why: (entry.replaced?.reason ?? entry.reason ?? "").slice(0, 110)
    }))
  );

  // No seeded owner move has a known engine loss >= 5.
  if (lookup) {
    for (const entry of entries) {
      const verdict = rootVerdict(lookup(entry.epd, "owner"), entry.uci);
      check(!verdict || verdict.loss < SEED_SOUND_LOSS, `${color} ply ${entry.ply} ${entry.san}: seeded with loss ${verdict?.loss.toFixed(1)}`);
    }
  }
  // Transpositions share one entry: EPDs are unique.
  check(new Set(entries.map((entry) => entry.epd)).size === entries.length, `${color}: an EPD has two entries`);

  const stats = repertoireStats(color, games, map as unknown as Map<string, RepEntry>, { now: window.end, halfLifeDays });
  console.log(
    `\nCoverage: ${stats.coverage.map((c) => `through ply ${c.ply}: ${c.stayed}/${c.games} (${c.rate === null ? "-" : Math.round(c.rate * 100)}%)`).join(", ")}`
  );
  console.log(`Top deviations (the owner's own games against the seed):`);
  printTable(stats.deviations.slice(0, 5).map((row) => ({ ply: row.ply, played: row.played.san, repertoire: row.expected.san, n: row.n, score: `${Math.round(row.score * 100)}%` })));
  console.log(`Top unprepared replies:`);
  printTable(stats.unprepared.slice(0, 5).map((row) => ({ ply: row.ply, reply: row.opp.san, n: row.n, score: `${Math.round(row.score * 100)}%`, lost: row.pointsLost.toFixed(2) })));

  if (golden) {
    const at = (ucis: string[]) => entryAt(map, ucis);
    if (color === "white") {
      check(at([])?.san === "c4", `White root is ${at([])?.san}, expected 1.c4`);
      check(at(["c2c4", "e7e5"])?.san === "Nc3", `1.c4 e5 continues ${at(["c2c4", "e7e5"])?.san}, expected 2.Nc3`);
    } else {
      const e4 = at(["e2e4"]);
      check(e4?.san === "d5", `vs 1.e4: ${e4?.san}, expected 1...d5`);
      check(e4?.status === "needs-review" && e4.replaced?.san === "e5", "vs 1.e4: 1...d5 is not a needs-review consolidation over 1...e5");
      check(at(["d2d4"])?.san === "d5", `vs 1.d4: ${at(["d2d4"])?.san}, expected 1...d5`);
      const albin = at(["d2d4", "d7d5", "c2c4"]);
      check(!!albin && ["e6", "c6", "dxc4"].includes(albin.san), `1.d4 d5 2.c4: ${albin?.san}, expected one of e6, c6, dxc4`);
      check(albin?.source === "seed-engine" && albin.status === "needs-review" && albin.replaced?.san === "e5", "the Albin entry is not a needs-review seed-engine replacement of 2...e5");
      const anglo = at(["e2e4", "d7d5", "e4d5", "d8d5", "b1c3"]);
      check(!!anglo, "no entry after 1.e4 d5 2.exd5 Qxd5 3.Nc3");
      const italian = at(["e2e4", "e7e5", "g1f3"]);
      if (italian) {
        check(italian.san === "Nc6", `1.e4 e5 2.Nf3: ${italian.san}, expected 2...Nc6`);
      }
      console.log(
        `\nGolden lines: vs 1.e4 ${e4?.san} (${e4?.status}); vs 1.d4 ${at(["d2d4"])?.san}; 1.d4 d5 2.c4 ${albin?.san} (${albin?.source}, replaces ${albin?.replaced?.san}); ` +
          `3.Nc3 in the Scandinavian: ${anglo?.san}; 1.e4 e5 2.Nf3: ${italian ? italian.san : "not reached (1.e4 is answered by 1...d5)"}.`
      );
    }
  }
}

db.close();
if (failures.length) {
  console.log(`\nFAILED (${failures.length}):`);
  for (const failure of failures.slice(0, 30)) {
    console.log(`- ${failure}`);
  }
  process.exit(1);
}
console.log("\nverify-repertoire: OK");

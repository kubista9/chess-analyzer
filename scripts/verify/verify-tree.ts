// Checks the per-colour opening trees over the SQLite store against the plan's golden
// numbers, plus the tree's count invariants, the book names and the book-exit distribution.
// Read-only; no engine.
//
//   npx tsx scripts/verify/verify-tree.ts --asof 2026-09-26
//
// The goldens (P3.md, GLOBAL.md) were measured unweighted, over the 183-day window ending
// 2026-09-26, with Chess.com's post-game ratings, on archives fetched on 2026-09-26 whose last
// game ended at 14:03:56Z. The owner played 3 more blitz games later that day, so the goldens
// are asserted on that snapshot (window end = SNAPSHOT_LAST_END) and the full --asof day is
// printed next to them, with the drift explained per line.
import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import { START_EPD } from "../../shared/epd.js";
import { bookExit, nameAt, openingFamily, type OpeningBook } from "../../shared/openingBook.js";
import { buildTree, nodeByMoves, type OpeningTree, type TreeEdge, type TreeGame } from "../../shared/openingTree.js";
import { replayOpening } from "../../shared/pgn.js";
import { ageDays, effectiveN, recencyWeight } from "../../shared/stats.js";
import type { PlayerColor } from "../../shared/types.js";
import { listGames } from "../../server/db/games.js";
import { loadOpeningBook } from "../../server/services/openingBook.js";
import { createTreeService, loadTreeGames, type RatingMode } from "../../server/services/treeService.js";
import { OWNER, openStoreReadonly, printTable, readAsofWindow, type TableRow } from "./_lib.js";

const GOLDEN_ASOF = "2026-09-26";
const GOLDEN_DAYS = 183;
/** end_time of the last game in the archives the goldens were measured on (2026-09-26T14:03:56Z). */
const SNAPSHOT_LAST_END = 1_790_431_436;

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
  }
}

const window = readAsofWindow();
const golden = window.asof === GOLDEN_ASOF && window.days === GOLDEN_DAYS;
const db = openStoreReadonly();

let started = performance.now();
const book = loadOpeningBook();
const bookMs = performance.now() - started;
console.log(
  `Book: ${book.rows} rows, ${book.positions.size} positions, ${book.named.size} named (${bookMs.toFixed(0)} ms to build).`
);
check(book.rows === 3815 && book.positions.size === 7864 && book.named.size === 3815, "book size differs from the pinned dataset");

function trees(end: number, ratings: RatingMode, halfLifeDays: number | null = null): Record<PlayerColor, OpeningTree> {
  const bounds = { start: window.start, end };
  const build = (color: PlayerColor) =>
    buildTree(loadTreeGames(db, OWNER, bounds, { color, timeClass: null }, ratings), { color, now: end, halfLifeDays, book });
  return { white: build("white"), black: build("black") };
}

const ucis = (line: string) => (line ? replayOpening(line.split(" "), 99).map((ply) => ply.uci) : []);
function edgeAt(tree: OpeningTree, line: string): TreeEdge | undefined {
  const moves = line.split(" ");
  const parent = nodeByMoves(tree, ucis(moves.slice(0, -1).join(" ")));
  const [last] = ucis(line).slice(-1);
  return parent?.edges.find((edge) => edge.uci === last);
}

// ---- Golden lines --------------------------------------------------------------------------
interface GoldenLine {
  color: PlayerColor;
  line: string;
  label: string;
  n: number;
  /** Score in %, with the golden's precision (decimals). */
  score: number;
  scoreDecimals: number;
  deltaPts?: number;
  ci?: [number, number];
}

const GOLDEN_LINES: GoldenLine[] = [
  { color: "white", line: "c4", label: "1.c4", n: 685, score: 54.7, scoreDecimals: 1 },
  { color: "white", line: "c4 c5", label: "1.c4 c5", n: 60, score: 36, scoreDecimals: 0, deltaPts: -8.2 },
  { color: "white", line: "c4 Nf6", label: "1.c4 Nf6", n: 56, score: 65, scoreDecimals: 0 },
  { color: "black", line: "e4 e5", label: "1.e4 e5", n: 216, score: 40, scoreDecimals: 0, deltaPts: -20.7, ci: [34, 46] },
  { color: "black", line: "e4 d5", label: "1.e4 d5 (Scandinavian)", n: 222, score: 55, scoreDecimals: 0, deltaPts: 9.8 },
  { color: "black", line: "d4 d5", label: "1.d4 d5", n: 161, score: 44, scoreDecimals: 0, deltaPts: -8.9 },
  { color: "black", line: "d4 d5 c4 e5", label: "1.d4 d5 2.c4 e5 (Albin)", n: 29, score: 33, scoreDecimals: 0 },
  { color: "black", line: "d4 d5 Bf4", label: "1.d4 d5 2.Bf4 (London)", n: 48, score: 53, scoreDecimals: 0 },
  { color: "black", line: "e4 e5 Nf3 Bc5", label: "1.e4 e5 2.Nf3 Bc5", n: 16, score: 46.9, scoreDecimals: 1 }
];

const pct = (value: number, decimals = 1) => Number((value * 100).toFixed(decimals));
const pts = (value: number) => Number(value.toFixed(1));

const snapshot = trees(Math.min(window.end, SNAPSHOT_LAST_END), "post-game");
const full = trees(window.end, "post-game");
const fullPre = trees(window.end, "pre-game");

const rows: TableRow[] = [];
for (const goldenLine of GOLDEN_LINES) {
  const snap = edgeAt(snapshot[goldenLine.color], goldenLine.line);
  const now = edgeAt(full[goldenLine.color], goldenLine.line);
  const pre = edgeAt(fullPre[goldenLine.color], goldenLine.line);
  if (!snap || !now || !pre) {
    failures.push(`${goldenLine.label}: not in the tree`);
    continue;
  }
  rows.push({
    line: `${goldenLine.color[0].toUpperCase()} ${goldenLine.label}`,
    "gold n": goldenLine.n,
    "snap n": snap.n,
    "gold %": goldenLine.score,
    "snap %": pct(snap.raw.score, goldenLine.scoreDecimals),
    "gold Δ": goldenLine.deltaPts,
    "snap Δ": pts(snap.raw.deltaPts),
    "snap CI": `[${pct(snap.raw.ci[0], 0)}, ${pct(snap.raw.ci[1], 0)}]`,
    "full n": now.n,
    "full %": pct(now.raw.score),
    "full Δ": pts(now.raw.deltaPts),
    "pre-game Δ": pts(pre.raw.deltaPts),
    name: now.name ? `${now.eco} ${now.name}` : ""
  });

  if (!golden) {
    continue;
  }
  const where = `${goldenLine.label} (snapshot)`;
  check(snap.n === goldenLine.n, `${where}: n ${snap.n}, golden ${goldenLine.n}`);
  check(pct(snap.raw.score, goldenLine.scoreDecimals) === goldenLine.score, `${where}: score ${pct(snap.raw.score, 2)}%, golden ${goldenLine.score}%`);
  if (goldenLine.deltaPts !== undefined) {
    check(pts(snap.raw.deltaPts) === goldenLine.deltaPts, `${where}: Δ ${snap.raw.deltaPts.toFixed(2)}, golden ${goldenLine.deltaPts}`);
  }
  if (goldenLine.ci) {
    const ci = [pct(snap.raw.ci[0], 0), pct(snap.raw.ci[1], 0)];
    check(ci[0] === goldenLine.ci[0] && ci[1] === goldenLine.ci[1], `${where}: CI [${ci.join(", ")}], golden [${goldenLine.ci.join(", ")}]`);
  }
  // The three later games can move a line by at most 2 games.
  check(Math.abs(now.n - snap.n) <= 2, `${goldenLine.label}: full-day n ${now.n} drifts more than 2 from the snapshot ${snap.n}`);
  // Pre-game ratings only nudge the expectation (critic: ~0.5 point on a 216-game line).
  check(Math.abs(pre.raw.deltaPts - now.raw.deltaPts) < 1.5, `${goldenLine.label}: pre-game Δ moves by more than 1.5 points`);
}

console.log(
  `\nGolden lines, unweighted. "snap" = window ${new Date(window.start * 1000).toISOString()} .. ` +
    `${new Date(Math.min(window.end, SNAPSHOT_LAST_END) * 1000).toISOString()} (the plan's archives), ` +
    `"full" = the whole --asof day; Δ = points vs the Elo expectation (post-game ratings unless noted).`
);
printTable(rows);

// ---- The games that arrived after the snapshot ---------------------------------------------
const late = listGames(db, OWNER, { start: SNAPSHOT_LAST_END + 1, end: window.end });
if (late.length) {
  console.log(`\n${late.length} game(s) after the snapshot (the drift between "snap" and "full"):`);
  for (const game of late) {
    const plies = loadTreeGames(db, OWNER, { start: game.endTime, end: game.endTime }, { color: game.color, timeClass: null }).find(
      (entry) => entry.id === game.id
    )!.plies;
    console.log(
      `  ${game.id} ${new Date(game.endTime * 1000).toISOString()} ${game.timeClass} as ${game.color}, ${game.result}: ` +
        plies.slice(0, 6).map((ply) => ply.san).join(" ")
    );
  }
}

// ---- Totals, ESS and names -----------------------------------------------------------------
for (const color of ["white", "black"] as PlayerColor[]) {
  const root = full[color].nodes.get(START_EPD)!;
  console.log(`\n${color}: ${full[color].games} games (snapshot ${snapshot[color].games}), ${full[color].nodes.size} positions.`);
  check(root.n === full[color].games, `${color}: root n ${root.n} != ${full[color].games} games`);
}
if (golden) {
  check(snapshot.white.games === 685 && snapshot.black.games === 692, `snapshot games ${snapshot.white.games}/${snapshot.black.games}, golden 685/692`);
}

const allGames: TreeGame[] = [
  ...loadTreeGames(db, OWNER, window, { color: "white", timeClass: null }),
  ...loadTreeGames(db, OWNER, window, { color: "black", timeClass: null })
];
let sumW = 0;
let sumW2 = 0;
for (const game of allGames) {
  const w = recencyWeight(ageDays(game.endTime, window.end), 60);
  sumW += w;
  sumW2 += w * w;
}
const ess60 = effectiveN(sumW, sumW2);
console.log(`ESS at H = 60 over ${allGames.length} games: ${ess60.toFixed(0)} (Σw ${sumW.toFixed(0)}); golden about 1,069.`);
check(!golden || Math.abs(ess60 - 1069) <= 8, `ESS at H = 60 is ${ess60.toFixed(1)}, golden about 1,069`);

const epdsAfter = (game: TreeGame) => game.plies.slice(0, OPENING_PLY_LIMIT).map((ply) => ply.epdAfter);
const whiteGames = allGames.filter((game) => game.color === "white");
const english = whiteGames.filter((game) => {
  const hit = nameAt(book, epdsAfter(game));
  return hit && openingFamily(hit.name) === "English Opening";
}).length;
console.log(`White games whose deepest name is in the English Opening family: ${english} of ${whiteGames.length}.`);
check(!golden || english >= 659, `only ${english} White games are English Opening (want >= 659)`);

function checkName(color: PlayerColor, line: string, expected: string): void {
  const edge = edgeAt(full[color], line);
  const got = edge && edge.nameExact ? `${edge.eco} ${edge.name}` : `(none: ${edge?.name ?? "not in tree"})`;
  console.log(`  ${line.padEnd(28)} ${got}`);
  check(got === expected, `${line}: name "${got}", want "${expected}"`);
}
console.log("Names:");
checkName("black", "e4 d5 exd5 Qxd5 Nc3 Qa5", "B01 Scandinavian Defense: Main Line");
checkName("black", "d4 d5 c4 e5", "D08 Queen's Gambit Declined: Albin Countergambit");
checkName("black", "e4 e5 Nf3 Bc5", "C40 King's Pawn Game: Busch-Gass Gambit");
checkName("black", "d4 d5 Bf4", "D00 Queen's Pawn Game: Accelerated London System");

// ---- Book exit -----------------------------------------------------------------------------
function quantile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(p * (sorted.length - 1))];
}
const exits = allGames.map((game) => bookExit(book, epdsAfter(game), game.color));
const lastBook = exits.map((exit) => exit.lastBookPly);
const exitBy = { owner: 0, opponent: 0, never: 0 };
for (const exit of exits) {
  exitBy[exit.exitBy ?? "never"] += 1;
}
const median = quantile(lastBook, 0.5);
const p90 = quantile(lastBook, 0.9);
console.log(
  `\nBook exit (last book ply): p25 ${quantile(lastBook, 0.25)}, median ${median}, p75 ${quantile(lastBook, 0.75)}, p90 ${p90}; ` +
    `left first by the opponent ${exitBy.opponent}, by the owner ${exitBy.owner}, never ${exitBy.never}.`
);
check(!golden || (median === 4 && p90 === 7), `book exit median ${median} / p90 ${p90}, golden 4 / 7`);

// ---- Count invariants along every path -------------------------------------------------------
let edges = 0;
for (const color of ["white", "black"] as PlayerColor[]) {
  const tree = full[color];
  const incoming = new Map<string, number>();
  for (const node of tree.nodes.values()) {
    const out = node.edges.reduce((sum, edge) => sum + edge.n, 0);
    check(out + node.ended === node.n, `${color} ${node.epd}: out-edges ${out} + ended ${node.ended} != n ${node.n}`);
    for (const edge of node.edges) {
      edges += 1;
      check(edge.wins + edge.draws + edge.losses === edge.n, `${color} ${node.epd} ${edge.san}: W+D+L != n`);
      check(edge.gameIds.length === edge.n && new Set(edge.gameIds).size === edge.n, `${color} ${node.epd} ${edge.san}: game ids != n`);
      check(edge.owner === node.ownerToMove, `${color} ${node.epd} ${edge.san}: owner flag differs from the side to move`);
      check(tree.nodes.has(edge.toEpd), `${color} ${node.epd} ${edge.san}: target missing`);
      incoming.set(edge.toEpd, (incoming.get(edge.toEpd) ?? 0) + edge.n);
    }
  }
  for (const node of tree.nodes.values()) {
    const into = node.epd === START_EPD ? tree.games : incoming.get(node.epd) ?? 0;
    check(into === node.n, `${color} ${node.epd}: incoming ${into} != n ${node.n}`);
  }
  console.log(`${color}: counts consistent along every path (${tree.repetitionStops} games stopped at a repeated position).`);
}
console.log(`Checked ${edges} edges.`);

// ---- The service: default weighting and timing -------------------------------------------------
const service = createTreeService({ db: () => db, owner: OWNER, book: (): OpeningBook => book });
const nowMs = window.end * 1000;
started = performance.now();
const cold = service.getTree({ color: "black", window: "6m", timeClass: null, halfLifeDays: 90 }, nowMs);
const coldMs = performance.now() - started;
started = performance.now();
const warm = service.getTree({ color: "black", window: "6m", timeClass: null, halfLifeDays: 90 }, nowMs);
const node = warm.tree.nodes.get(nodeByMoves(warm.tree, ucis("e4"))!.epd)!;
JSON.stringify(node);
const warmMs = performance.now() - started;
console.log(`\nService (black, 6m, default H = 90): build ${coldMs.toFixed(0)} ms, warm node request ${warmMs.toFixed(1)} ms.`);
check(coldMs < 300, `tree build took ${coldMs.toFixed(0)} ms (want < 300)`);
check(warmMs < 100, `warm node request took ${warmMs.toFixed(1)} ms (want < 100)`);
check(cold.tree === warm.tree, "the second request was not memoised");
printTable(
  node.edges.slice(0, 6).map((edge) => ({
    "vs 1.e4": edge.san,
    n: edge.n,
    "score%": pct(edge.raw.score),
    wN: Number(edge.weighted.wN.toFixed(1)),
    ESS: Number(edge.weighted.ess.toFixed(1)),
    "w score%": pct(edge.weighted.score),
    "w CI": `[${pct(edge.weighted.ci[0], 0)}, ${pct(edge.weighted.ci[1], 0)}]`,
    "w Δ": pts(edge.weighted.deltaPts),
    z: edge.weighted.z === null ? null : Number(edge.weighted.z.toFixed(2)),
    "90d": `${edge.trend.recentN} vs ${edge.trend.olderN}`,
    "think s": edge.thinkTime ? Number((edge.thinkTime.avgMs / 1000).toFixed(1)) : null,
    name: edge.name ?? ""
  }))
);

// ---- Filters: blitz + rapid = all, and 3 months is a subset ---------------------------------
for (const color of ["white", "black"] as PlayerColor[]) {
  const get = (window: "6m" | "3m", timeClass: "blitz" | "rapid" | null) =>
    service.getTree({ color, window, timeClass, halfLifeDays: null }, nowMs).tree;
  const all = get("6m", null);
  const blitz = get("6m", "blitz");
  const rapid = get("6m", "rapid");
  const recent = get("3m", null);
  console.log(`${color}: 6m ${all.games} = ${blitz.games} blitz + ${rapid.games} rapid; 3m ${recent.games}.`);
  check(blitz.games + rapid.games === all.games, `${color}: blitz + rapid != all`);
  check(recent.games < all.games, `${color}: 3m is not a subset of 6m`);
  for (const edge of all.nodes.get(START_EPD)!.edges) {
    const split = [blitz, rapid].map((tree) => tree.nodes.get(START_EPD)!.edges.find((e) => e.uci === edge.uci)?.n ?? 0);
    check(split[0] + split[1] === edge.n, `${color} ${edge.san}: blitz + rapid n != ${edge.n}`);
  }
}

if (!golden) {
  console.log(`\n(--asof ${window.asof} --days ${window.days}: golden comparisons skipped; they need --asof ${GOLDEN_ASOF}.)`);
}
if (failures.length) {
  console.error(`\nFAILED (${failures.length}):\n- ${failures.slice(0, 40).join("\n- ")}`);
  process.exit(1);
}
console.log("\nOK: golden lines, names, ESS, book exit and path counts all check out.");

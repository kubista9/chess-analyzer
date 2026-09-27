// Checks fix-list v0 over the SQLite store: prints the leaks and the watch lines, checks them
// against the tree and the plan's expectations, and re-runs the P3 critic's null simulation to
// show the gate emits about what the null predicts or fewer. Read-only; no engine.
//
//   npx tsx scripts/verify/verify-fixlist.ts --asof 2026-09-26 [--sims 200] [--seed 1]
//
// Null simulation: every game's result is redrawn as a win with probability E (its Elo
// expectation) or a loss otherwise, so no line has a real leak. The same draw is used for a game
// in every line it passes through, and the fix list is recomputed from scratch. Anything the
// gate emits under the null is a false positive.
//
// The critic's check (scratchpad/bench/fp.mjs): 105 owner-move lines with n >= 8 (6 months,
// 20 plies, H = 60, post-game ratings); the plan's gate "PL >= 1 and (z >= 1 or Wilson hi < 50%)"
// emits 9 real vs 11.8 under the null, and with z >= 1.64 7 real vs 4.5. The expectation for the
// new gate (z >= 1.64 plus Benjamini-Hochberg at q = 0.2 over the whole candidate set): under the
// null BH keeps the chance of ANY discovery at or below q, so about 0.2 false items per run or
// fewer, well under the real count.
import {
  FIX_FDR_Q,
  FIX_MIN_ESS,
  FIX_MIN_N,
  FIX_MIN_Z,
  collectCandidates,
  selectLeaks,
  type CandidateGame,
  type FixCandidate,
  type FixItem
} from "../../shared/fixList.js";
import { buildTree, walkMoves, type OpeningTree, type TreeGame } from "../../shared/openingTree.js";
import { wilson } from "../../shared/stats.js";
import type { PlayerColor } from "../../shared/types.js";
import { loadOpeningBook } from "../../server/services/openingBook.js";
import { DEFAULT_HALF_LIFE_BY_WINDOW, loadTreeGames, type RatingMode } from "../../server/services/treeService.js";
import { OWNER, argValue, openStoreReadonly, printTable, readAsofWindow } from "./_lib.js";

const GOLDEN_ASOF = "2026-09-26";

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
  }
}

const window = readAsofWindow();
const golden = window.asof === GOLDEN_ASOF && window.days === 183;
const sims = Number(argValue("sims") ?? 200);
const seed = Number(argValue("seed") ?? 1);
const db = openStoreReadonly();
const book = loadOpeningBook();
const COLORS: PlayerColor[] = ["white", "black"];

function build(halfLifeDays: number | null, ratings: RatingMode) {
  return COLORS.map((color) => {
    const games = loadTreeGames(db, OWNER, window, { color, timeClass: null }, ratings);
    const tree = buildTree(games, { color, now: window.end, halfLifeDays, book });
    return { color, games, tree };
  });
}

// ---- The fix list in the app's default view (6m, H = 90, pre-game ratings) ------------------
const halfLife = DEFAULT_HALF_LIFE_BY_WINDOW["6m"];
const view = build(halfLife, "pre-game");
let started = performance.now();
const candidates = view.flatMap(({ tree, games }) => collectCandidates(tree, games));
const selection = selectLeaks(candidates);
const selectMs = performance.now() - started;
console.log(
  `Default view: ${window.asof}, ${window.days} days, H = ${halfLife}, pre-game ratings, blitz + rapid ` +
    `(${view.map((part) => `${part.games.length} ${part.color}`).join(", ")}).`
);
console.log(
  `Candidates (owner moves with n >= ${FIX_MIN_N} and ESS >= ${FIX_MIN_ESS}): ${selection.tested} ` +
    `(${view.map((part) => `${candidates.filter((c) => c.color === part.color).length} ${part.color}`).join(", ")}); ` +
    `significant (z >= ${FIX_MIN_Z} and BH q = ${FIX_FDR_Q}): ${selection.significant}; ` +
    `leaks after blame attribution: ${selection.items.length}; watch: ${selection.watch.length} (${selectMs.toFixed(0)} ms).`
);

const pct = (value: number) => Number((value * 100).toFixed(1));
const rows = (items: FixItem[]) =>
  items.map((item) => ({
    colour: item.color,
    line: item.line,
    name: item.name ? `${item.eco} ${item.name}`.slice(0, 44) : "",
    n: item.n,
    ess: Math.round(item.ess),
    score: pct(item.score),
    ci: `${Math.round(item.ci[0] * 100)}-${Math.round(item.ci[1] * 100)}`,
    exp: pct(item.expected),
    "Δpts": Number(item.deltaPts.toFixed(2)),
    z: Number(item.z.toFixed(2)),
    q: Number(item.q.toFixed(3)),
    lost: Number(item.pointsLost.toFixed(2)),
    resN: item.residualN,
    early: `${item.earlyLoss.n}/${item.n}`,
    trend: `${item.trend.recentN} vs ${item.trend.olderN} ${item.trend.direction}`
  }));
console.log("\nLeaks (ranked by weighted points lost that no deeper leak explains):");
printTable(rows(selection.items));
console.log("\nWatch (z >= 1.64 on their own, not BH discoveries; as likely as not noise):");
printTable(rows(selection.watch));

// ---- Consistency with the tree ---------------------------------------------------------------
const trees = new Map<PlayerColor, OpeningTree>(view.map((part) => [part.color, part.tree]));
for (const item of [...selection.items, ...selection.watch]) {
  const walk = walkMoves(trees.get(item.color)!, item.moves.slice(0, -1));
  const edge = walk.node?.edges.find((candidate) => candidate.uci === item.moves.at(-1));
  check(Boolean(edge && walk.node?.ownerToMove), `${item.id}: not an owner move in the tree`);
  if (edge) {
    check(edge.n === item.n && edge.san === item.sans.at(-1), `${item.id}: n/SAN differ from the tree edge`);
    check(Math.abs(edge.weighted.deltaPts - item.deltaPts) < 1e-9, `${item.id}: Δpts differs from the tree edge`);
    check(Math.abs((edge.weighted.z ?? 0) - item.z) < 1e-9, `${item.id}: z differs from the tree edge`);
  }
  check(item.pointsLost <= -item.deltaPts + 1e-9 || item.explainedBy.length === 0, `${item.id}: blamed for more than it lost`);
  check(item.residualN <= item.n && item.residualN >= FIX_MIN_N, `${item.id}: residual n out of range`);
  check(item.examples.length === Math.min(3, item.residualN), `${item.id}: expected 3 examples`);
  check(item.examples.every((example) => example.ply === item.moves.length), `${item.id}: example ply is not the move's ply`);
}
for (const item of selection.items) {
  for (const deeper of item.explainedBy) {
    check(selection.items.some((other) => other.id === deeper), `${item.id}: explained by ${deeper}, which is not a leak`);
  }
}

// ---- Expectations on the owner's data -----------------------------------------------------------
if (golden) {
  const ids = new Set(selection.items.map((item) => item.id));
  const has = (color: PlayerColor, sans: string) => [...selection.items, ...selection.watch].find((item) => item.color === color && item.sans.join(" ") === sans);
  const e5 = has("black", "e4 e5");
  const nc6 = has("black", "e4 e5 Nf3 Nc6");
  check(e5?.tier === "leak", "1.e4 e5 is not a leak");
  check(nc6?.tier === "leak", "1.e4 e5 2.Nf3 Nc6 is not a leak");
  check(Boolean(e5 && nc6 && e5.explainedBy.includes(nc6.id)), "1.e4 e5 should be explained in part by 2.Nf3 Nc6 (blame attribution)");
  check(selection.items[0]?.id === nc6?.id, "2.Nf3 Nc6 should rank first");
  check(has("black", "d4 d5 c4 e5")?.tier === "watch", "the Albin (1.d4 d5 2.c4 e5) should be on the watch list");
  check(
    [...selection.items, ...selection.watch].some((item) => item.color === "white" && item.sans.slice(0, 2).join(" ") === "c4 c5"),
    "no 1.c4 c5 line on either list"
  );
  for (const item of [...selection.items, ...selection.watch]) {
    const line = item.sans.join(" ");
    check(!(item.color === "black" && line.startsWith("e4 d5")), `the Scandinavian (${item.line}) should not be listed`);
    check(!(item.color === "black" && line.startsWith("d4 d5 Bf4")), `a 2.Bf4 line (${item.line}) should not be listed`);
  }
  check(ids.size === selection.items.length, "duplicate item ids");
}

// ---- Null simulation -----------------------------------------------------------------------------
/** mulberry32: a small seeded PRNG, so the simulation is reproducible. */
function prng(state: number): () => number {
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The plan's gate, the one the critic measured: PL >= 1 and (z >= zMin or Wilson hi < 50%), before attribution. */
function planGate(candidate: FixCandidate, zMin: number, s: (game: CandidateGame) => number): boolean {
  let pl = 0;
  let variance = 0;
  let sumW = 0;
  let sumW2 = 0;
  let sumWS = 0;
  for (const game of candidate.games) {
    const score = s(game);
    pl += game.w * (game.e - score);
    variance += game.w * game.w * game.e * (1 - game.e);
    sumW += game.w;
    sumW2 += game.w * game.w;
    sumWS += game.w * score;
  }
  const z = pl / Math.sqrt(variance);
  const hi = wilson(sumWS / sumW, (sumW * sumW) / sumW2)[1];
  return pl >= 1 && (z >= zMin || hi < 0.5);
}

function nullRun(parts: { games: TreeGame[] }[], cands: FixCandidate[], label: string) {
  const random = prng(seed);
  const expected = new Map<string, number>();
  for (const candidate of cands) {
    for (const game of candidate.games) {
      expected.set(game.id, game.e);
    }
  }
  const ids = parts.flatMap((part) => part.games.map((game) => game.id)).filter((id) => expected.has(id));
  let leaks = 0;
  let watch = 0;
  let anyLeak = 0;
  const plan = { z1: 0, z164: 0 };
  for (let run = 0; run < sims; run += 1) {
    const drawn = new Map(ids.map((id) => [id, random() < expected.get(id)! ? 1 : 0]));
    const s = (game: CandidateGame) => drawn.get(game.id)!;
    const result = selectLeaks(cands, s);
    leaks += result.items.length;
    watch += result.watch.length;
    anyLeak += result.items.length ? 1 : 0;
    plan.z1 += cands.filter((candidate) => planGate(candidate, 1, s)).length;
    plan.z164 += cands.filter((candidate) => planGate(candidate, 1.64, s)).length;
  }
  const real = selectLeaks(cands);
  const realPlan = (zMin: number) => cands.filter((candidate) => planGate(candidate, zMin, (game) => game.s)).length;
  console.log(`\n${label}: ${cands.length} candidates, ${sims} null runs (seed ${seed}).`);
  printTable([
    { gate: "plan: PL >= 1 and (z >= 1 or hi < 50%)", real: realPlan(1), null: Number((plan.z1 / sims).toFixed(2)) },
    { gate: "plan: PL >= 1 and (z >= 1.64 or hi < 50%)", real: realPlan(1.64), null: Number((plan.z164 / sims).toFixed(2)) },
    { gate: "fix list v0: leaks (BH, after attribution)", real: real.items.length, null: Number((leaks / sims).toFixed(2)) },
    { gate: "fix list v0: watch (z >= 1.64, not BH)", real: real.watch.length, null: Number((watch / sims).toFixed(2)) }
  ]);
  console.log(`Null runs with at least one leak: ${((anyLeak / sims) * 100).toFixed(1)}% (BH bound: ${FIX_FDR_Q * 100}%).`);
  return { leaks: leaks / sims, anyLeak: anyLeak / sims, real: real.items.length };
}

// The critic's setup: H = 60, post-game ratings, n >= 8 without the ESS gate.
const critic = build(60, "post-game");
const criticCands = critic.flatMap(({ tree, games }) => collectCandidates(tree, games, { minN: FIX_MIN_N, minEss: 0 }));
nullRun(critic, criticCands, "Critic's setup (H = 60, post-game ratings, n >= 8, no ESS gate)");

// The app's default view, with every gate.
started = performance.now();
const appNull = nullRun(view, candidates, `App default (H = ${halfLife}, pre-game ratings, n >= 8 and ESS >= 8)`);
console.log(`(${((performance.now() - started) / 1000).toFixed(1)} s)`);
check(appNull.leaks <= 0.5, `the null emits ${appNull.leaks.toFixed(2)} leaks per run; expected at most about 0.2-0.5`);
check(appNull.anyLeak <= FIX_FDR_Q + 0.05, `${(appNull.anyLeak * 100).toFixed(1)}% of null runs emit a leak (BH bound ${FIX_FDR_Q * 100}%)`);
check(appNull.real > appNull.leaks, "the real data emits no more leaks than the null");

if (!golden) {
  console.log(`\n(--asof ${window.asof} --days ${window.days}: the expectations on the owner's lines need --asof ${GOLDEN_ASOF}.)`);
}
if (failures.length) {
  console.error(`\nFAILED (${failures.length}):\n- ${failures.slice(0, 40).join("\n- ")}`);
  process.exit(1);
}
console.log("\nOK: fix list consistent with the tree, expectations met, and the gate stays at or under the null's expected count.");

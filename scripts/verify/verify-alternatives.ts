// Prints the alternatives panel for the owner's main leaks and checks the P7 acceptance lines:
// - 1.d4 d5 2.c4 (the Albin 2...e5): at least two of 2...e6 / 2...c6 / 2...dxc4 among the
//   alternatives, each within 5 win% of the deep best with a 6-ply legal SAN line and reasons;
// - 1.e4 e5 2.Nf3 questioning 2...Bc5: 2...Nc6 ranks first, marked as a move the owner plays;
// - 1.e4 e5 2.Nf3 questioning 2...Nc6 (itself a results leak): alternatives as suggestions, and
//   "change earlier" towards 1...d5; deep in the Albin, "change earlier" towards 2.c4's moves;
// - 1.d4 questioning 1...d5: the points are placed in the replies, 1...d5 itself is not rejected;
// - the honesty block is always present, and the same input ranks identically.
// The deep tier is searched (and stored in storage/chess.db) where it is missing, at most one
// deep search per position plus the only-move checks; --cached skips every search.
//
//   npx tsx scripts/verify/verify-alternatives.ts --asof 2026-09-26 [--cached]
import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import type { AlternativesResult, Alternative } from "../../shared/alternatives.js";
import { buildFixList } from "../../shared/fixList.js";
import { formatEval } from "../../shared/eval.js";
import { buildTree, formatLine, walkMoves, type OpeningTree, type TreeGame } from "../../shared/openingTree.js";
import { seedFlags } from "../../shared/repertoireSeed.js";
import type { PlayerColor } from "../../shared/types.js";
import { config } from "../../server/config.js";
import { openDatabase } from "../../server/db/connection.js";
import { currentEngineConfig } from "../../server/engine/engineConfig.js";
import { EnginePool } from "../../server/engine/pool.js";
import { engineOptions } from "../../server/engine/sharedPool.js";
import { UciEngine, detectEngineId } from "../../server/engine/uci.js";
import { createAnalysisIndex } from "../../server/services/analysisIndex.js";
import { alternativesState, completeAlternatives, type AltSource } from "../../server/services/alternatives.js";
import { loadOpeningBook } from "../../server/services/openingBook.js";
import { loadRepertoire } from "../../server/services/repertoireService.js";
import { DEFAULT_HALF_LIFE_BY_WINDOW, loadTreeGames } from "../../server/services/treeService.js";
import { OWNER, readAsofWindow } from "./_lib.js";

const GOLDEN_ASOF = "2026-09-26";
const cachedOnly = process.argv.includes("--cached");
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) {
    failures.push(message);
  }
};

const window = readAsofWindow();
const golden = window.asof === GOLDEN_ASOF && window.days === 183;
const db = openDatabase(config.dbPath);
const book = loadOpeningBook();
const halfLifeDays = DEFAULT_HALF_LIFE_BY_WINDOW["6m"];
const built = (["white", "black"] as PlayerColor[]).map((color) => {
  const games = loadTreeGames(db, OWNER, window, { color, timeClass: null });
  return { color, games, tree: buildTree(games, { color, now: window.end, halfLifeDays, book }) };
});
const treeOf = (color: PlayerColor) => built.find((entry) => entry.color === color)! as { tree: OpeningTree; games: TreeGame[] };

const configId = currentEngineConfig(db, await detectEngineId(engineOptions())).id;
const index = createAnalysisIndex({ book: () => book, maxPly: OPENING_PLY_LIMIT });
const lookup = () => index.view(db, configId).lookup;
const fix = buildFixList(built, index.view(db, configId));
const flagged = [...fix.items, ...fix.watch];
const entries = loadRepertoire(db, OWNER);
const pool = cachedOnly ? null : new EnginePool({ size: 2, spawn: () => UciEngine.start(engineOptions()) });

console.log(
  `Window ${window.asof} (${window.days} days, H = ${halfLifeDays}); engine config #${configId}; ${fix.items.length} leaks and ${fix.watch.length} watch lines as flags` +
    `${cachedOnly ? "; cache only" : ""}.`
);

interface Case {
  title: string;
  color: PlayerColor;
  moves: string[];
  uci: string | null;
}

const costs: { title: string; ms: number; nodes: number; searched: number }[] = [];

async function alternativesAt(spec: Case): Promise<AlternativesResult | null> {
  const { tree, games } = treeOf(spec.color);
  const walk = walkMoves(tree, spec.moves);
  if (!walk.node) {
    console.log(`\n## ${spec.title}: not reached by the ${spec.color} games in this window.`);
    return null;
  }
  const source: AltSource = {
    tree,
    games,
    book,
    epd: walk.node.epd,
    path: { moves: walk.path.map((step) => step.uci), sans: walk.path.map((step) => step.san) },
    lookup: lookup(),
    flags: seedFlags(flagged, spec.color),
    entries: entries[spec.color],
    current: spec.uci
  };
  let state = alternativesState(source, { db, configId });
  if (!state.ready && pool) {
    const { cost } = await completeAlternatives({ db, pool, configId }, source, lookup);
    costs.push({ title: spec.title, ms: cost.ms, nodes: cost.nodes.deep + cost.nodes.onlyMoves, searched: cost.searched });
    state = alternativesState({ ...source, lookup: lookup() }, { db, configId });
  }
  const result = state.ready ? state.result : state.preliminary;
  // Determinism: the same input ranks identically.
  const again = alternativesState({ ...source, lookup: lookup() }, { db, configId });
  check(JSON.stringify(again.ready ? again.result : again.preliminary) === JSON.stringify(result), `${spec.title}: a second ranking differs`);
  check(result.honesty.length >= 4, `${spec.title}: no honesty block`);
  print(spec.title, result, state.ready);
  return result;
}

const evalText = (alternative: Alternative) =>
  `${formatEval(alternative.eval.white)} (you ${alternative.eval.winPct.toFixed(1)}%, gap ${alternative.eval.gap.toFixed(1)})`;

function print(title: string, result: AlternativesResult, complete: boolean): void {
  console.log(`\n## ${title}: ${formatLine(result.sans) || "start"}${result.name ? ` (${result.eco} ${result.name})` : ""}, ${result.n} games`);
  console.log(
    `Engine: ${result.engine ? `${result.engine.tier} tier, depth ${result.engine.depth}, MultiPV ${result.engine.multipv}, ${result.engine.nodes} nodes, best ${result.engine.bestSan}` : "none"}` +
      `${complete ? "" : " (PRELIMINARY: deep tier missing)"}`
  );
  const current = result.current;
  if (current) {
    console.log(
      `Questioned: ${formatLine([current.san], result.ply)} (${current.source}) ${current.eval ? `gap ${current.eval.gap.toFixed(1)}` : "not scored"}` +
        `${current.hole ? " HOLE" : ""}${current.flag ? `; ${current.flag.tier}: ${Math.round(current.flag.score * 100)}% over ${current.flag.n} (z ${current.flag.z.toFixed(2)})` : ""}` +
        `${current.ownerStats ? `; ${current.ownerStats.n} games ${Math.round(current.ownerStats.score * 100)}%` : ""}`
    );
  }
  for (const [rank, alternative] of [...result.alternatives, ...result.others].entries()) {
    const marker = rank < result.alternatives.length ? `#${rank + 1}` : "  +";
    console.log(
      `${marker} ${formatLine([alternative.san], result.ply)} [${alternative.kind}] score ${alternative.score.toFixed(1)} · ${evalText(alternative)} · ${alternative.eco ?? ""} ${alternative.name ?? "(unnamed)"}`
    );
    console.log(`     line: ${formatLine(alternative.sampleLine.sans, result.ply)} · replies: ${alternative.replies.map((reply) => `${reply.san}(${reply.source}${reply.n ? ` ${reply.n}` : ""})`).join(" ")}`);
    for (const reason of alternative.reasons) {
      console.log(`     ${reason.points >= 0 ? "+" : ""}${reason.points.toFixed(1).padStart(4)} ${reason.feature}: ${reason.text}`);
    }
  }
  if (result.rejected.length) {
    console.log(`Rejected: ${result.rejected.map((move) => `${move.san} (${move.gap === null ? "unscored" : move.gap.toFixed(1)})`).join(", ")}`);
  }
  if (result.pointsLost) {
    const lost = result.pointsLost;
    console.log(`Where the points are lost after ${lost.san} (${lost.n} games, ${Math.round(lost.score * 100)}%, ${lost.pointsLost.toFixed(2)} pts):`);
    for (const row of lost.rows) {
      console.log(
        `   ${row.san.padEnd(6)} ${String(row.n).padStart(4)} games ${String(Math.round(row.score * 100)).padStart(3)}% lost ${row.pointsLost.toFixed(2).padStart(6)} · ` +
          row.answers.map((answer) => `${answer.san} ${answer.n}/${answer.pointsLost.toFixed(2)}`).join(", ")
      );
    }
  }
  for (const suggestion of result.ancestors) {
    console.log(
      `Change earlier (${suggestion.kind}): after ${formatLine(suggestion.sans) || "the start"} play ${suggestion.play.map((move) => formatLine([move.san], suggestion.ply)).join(" / ")} ` +
        `instead of ${formatLine([suggestion.instead.san], suggestion.ply)}. ${suggestion.reason}`
    );
  }
}

const sans = (alternatives: Alternative[]) => alternatives.map((alternative) => alternative.san);

try {
  const albin = await alternativesAt({ title: "The Albin", color: "black", moves: ["d2d4", "d7d5", "c2c4"], uci: "e7e5" });
  const bc5 = await alternativesAt({ title: "2...Bc5", color: "black", moves: ["e2e4", "e7e5", "g1f3"], uci: "f8c5" });
  const nc6 = await alternativesAt({ title: "2...Nc6 (a results leak)", color: "black", moves: ["e2e4", "e7e5", "g1f3"], uci: "b8c6" });
  const e4 = await alternativesAt({ title: "1...e5 against 1.e4", color: "black", moves: ["e2e4"], uci: "e7e5" });
  const d4 = await alternativesAt({ title: "1...d5 against 1.d4", color: "black", moves: ["d2d4"], uci: "d7d5" });
  const deepAlbin = await alternativesAt({ title: "Deep in the Albin", color: "black", moves: ["d2d4", "d7d5", "c2c4", "e7e5", "d4e5"], uci: null });
  const c4c5 = await alternativesAt({ title: "1.c4 c5 (White)", color: "white", moves: ["c2c4", "c7c5"], uci: null });
  void e4;
  void c4c5;

  if (golden) {
    check(albin !== null, "the Albin position is not reached");
    if (albin) {
      check(albin.engine?.tier === "deep", "the Albin is not ranked on the deep tier");
      const top = sans(albin.alternatives);
      check(["e6", "c6", "dxc4"].filter((san) => top.includes(san)).length >= 2, `the Albin's top alternatives ${top.join(", ")} hold fewer than two of e6, c6, dxc4`);
      for (const alternative of albin.alternatives) {
        check(alternative.eval.gap <= albin.gate, `Albin ${alternative.san}: gap ${alternative.eval.gap} above the gate`);
        check(alternative.sampleLine.sans.length === 6, `Albin ${alternative.san}: the sample line has ${alternative.sampleLine.sans.length} plies`);
        check(alternative.reasons.length >= 2, `Albin ${alternative.san}: fewer than two reasons`);
      }
      check(albin.current?.san === "e5" && albin.current.flag !== null, "the Albin's 2...e5 is not questioned with its results flag");
    }
    check(bc5?.alternatives[0]?.san === "Nc6", `after 1.e4 e5 2.Nf3 (2...Bc5) the first alternative is ${bc5?.alternatives[0]?.san}, not Nc6`);
    check(bc5?.alternatives[0]?.reasons.some((reason) => reason.feature === "owned") === true, "2...Nc6 is not marked as a move you play");
    check(bc5?.current?.hole === true, "2...Bc5 is not flagged as a hole on the deep tier");
    if (nc6) {
      check(nc6.alternatives.length > 0, "no alternatives are offered for the 2...Nc6 leak");
      check(nc6.ancestors.some((suggestion) => suggestion.kind === "results" && suggestion.play[0]?.san === "d5"), "no 'change earlier' towards 1...d5 at 1.e4");
    }
    if (d4) {
      const rows = d4.pointsLost?.rows.map((row) => row.san) ?? [];
      check(rows.slice(0, 3).includes("c4"), `vs 1.d4 the points lost are not placed in 2.c4 (rows ${rows.join(", ")})`);
      check(d4.ancestors.length === 0, "vs 1.d4 a 'change earlier' appears at the start");
    }
    if (deepAlbin) {
      const leak = deepAlbin.ancestors.find((suggestion) => suggestion.kind === "leak");
      check(leak !== undefined && leak.play.some((move) => ["e6", "c6", "dxc4"].includes(move.san)), "deep in the Albin, no 'change earlier' towards 2...e6 / c6 / dxc4");
    }
  }
} finally {
  await pool?.close();
}

if (costs.length) {
  console.log("\nPer-open engine cost (cold: deep root + only-move checks, 2 workers):");
  for (const cost of costs) {
    console.log(`   ${cost.title.padEnd(26)} ${(cost.ms / 1000).toFixed(1).padStart(5)} s  ${String(cost.nodes).padStart(9)} nodes  ${cost.searched} searches`);
  }
}
db.close();

if (failures.length) {
  console.log(`\nverify-alternatives: FAILED\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  process.exit(1);
}
console.log("\nverify-alternatives: OK");

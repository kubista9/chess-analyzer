// Verify the per-game opening analysis (P5): npx tsx scripts/verify/verify-analysis.ts --asof 2026-09-26
// It derives every window game's opening analysis from the position cache (nothing persisted)
// and prints:
// - coverage: games per colour with every ply scored, and owner moves still pending;
// - the class distribution of the owner's scored moves per colour;
// - the 10 most frequent owner mistakes (or worse): position, move, the engine's move, count;
// - the share of games with a first mistake by ply 10, 15 and 20 per colour, over the games
//   where that is known (the audit's baseline, at other thresholds: Black 34/54/74%, White
//   12/40/57%). With a partial backfill these shares are biased and only indicative.
// It asserts the critic's acceptance on the one EPD after 1.e4 e5 2.Nf3 (all 16 games share its
// eval): 2...Bc5 loses >= 8 win%, the best move is one of Nc6/Nf6/d6 and 3.Nxe5 is White's best
// reply; and that the Albin (1.d4 d5 2.c4 e5) is no engine hole. When those positions are not in
// the cache yet, it analyses just those two lines with one engine (a targeted run, a few
// seconds) and stores the results in the position cache; it never runs the full backfill.
// It also checks every eval in the analyses stays within +/-10.00 (mates as M#) and every loss
// within [0, 95.1].
import { MOVE_CATEGORIES, OPENING_PLY_LIMIT } from "../../shared/constants.js";
import { ENGINE_HOLE_MIN_LOSS } from "../../shared/fixList.js";
import { firstErrorShares, rootVerdict, sanOf, type OwnerMoveScored } from "../../shared/openingAnalysis.js";
import { formatLine } from "../../shared/openingTree.js";
import { Chess } from "chess.js";
import { toEpd } from "../../shared/epd.js";
import type { MoveCategory, PlayerColor } from "../../shared/types.js";
import { config } from "../../server/config.js";
import { openDatabase } from "../../server/db/connection.js";
import { currentEngineConfig, engineConfigKey } from "../../server/engine/engineConfig.js";
import { EnginePool } from "../../server/engine/pool.js";
import { ENGINE_PROTOCOL, canonicalJson } from "../../server/engine/protocol.js";
import { engineOptions } from "../../server/engine/sharedPool.js";
import { UciEngine, detectEngineId } from "../../server/engine/uci.js";
import { createAnalysisIndex } from "../../server/services/analysisIndex.js";
import { analyseLine } from "../../server/services/lineAnalysis.js";
import { loadOpeningBook } from "../../server/services/openingBook.js";
import { loadTreeGames } from "../../server/services/treeService.js";
import { OWNER, openStoreReadonly, printTable, readAsofWindow } from "./_lib.js";

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) {
    failures.push(message);
  }
};
const pct = (value: number | null) => (value === null ? "-" : `${(value * 100).toFixed(0)}%`);
const COLORS: PlayerColor[] = ["white", "black"];

/** The targeted lines: the owner's colour and the UCI moves up to and including the move checked. */
const LINES = {
  bc5: { color: "black" as PlayerColor, moves: ["e2e4", "e7e5", "g1f3", "f8c5"] },
  albin: { color: "black" as PlayerColor, moves: ["d2d4", "d7d5", "c2c4", "e7e5"] }
};

const window = readAsofWindow();
const idName = await detectEngineId(engineOptions());
const book = loadOpeningBook();
let store = openStoreReadonly();
const configRow = store
  .prepare("SELECT id FROM engine_configs WHERE engine_version = ? AND protocol_json = ?")
  .get(engineConfigKey(idName).engineVersion, canonicalJson(ENGINE_PROTOCOL)) as { id: number } | undefined;
let configId = configRow?.id ?? -1;
console.log(`Engine ${idName} · config #${configId} · window ${window.asof}, ${window.days} days.`);

// ---- Targeted analysis of the two lines, only if the cache cannot answer them ---------------
function lineAnswered(line: { moves: string[] }): boolean {
  if (configId < 0) {
    return false;
  }
  const view = createAnalysisIndex({ book: () => book, maxPly: OPENING_PLY_LIMIT }).view(store, configId);
  const { epdBefore, epdAfter } = plyOf(line.moves);
  return Boolean(rootVerdict(view.lookup(epdBefore, "owner"), line.moves.at(-1)!) && view.lookup(epdAfter, "opponent")?.lines[0]);
}

function plyOf(moves: readonly string[]) {
  const board = replayUciSans(moves);
  return board[board.length - 1];
}

/** The plies of a UCI line. */
function replayUciSans(moves: readonly string[]) {
  const chess = new Chess();
  return moves.map((uci) => {
    const epdBefore = toEpd(chess.fen());
    const { san } = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return { uci, san, epdBefore, epdAfter: toEpd(chess.fen()) };
  });
}

const missing = Object.entries(LINES).filter(([, line]) => !lineAnswered(line));
if (missing.length) {
  console.log(`Not in the position cache yet: ${missing.map(([name]) => name).join(", ")}. Running a targeted check of those lines only.`);
  const db = openDatabase(config.dbPath);
  const pool = new EnginePool({ size: 1, spawn: () => UciEngine.start(engineOptions()) });
  try {
    configId = currentEngineConfig(db, idName).id;
    for (const [name, line] of missing) {
      const started = Date.now();
      const result = await analyseLine({ db, pool, configId }, { owner: OWNER, color: line.color, moves: line.moves, windowStart: window.start });
      console.log(`  ${name}: ${result.searched} of ${result.positions.length} positions searched in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
    }
  } finally {
    await pool.close();
    db.close();
  }
  store.close();
  store = openStoreReadonly();
}

// ---- Every window game's analysis -------------------------------------------------------------
const index = createAnalysisIndex({ book: () => book, maxPly: OPENING_PLY_LIMIT });
const view = index.view(store, configId);
console.log(`Positions in the cache: ${view.positions}.`);

const byColor = new Map(
  COLORS.map((color) => {
    const games = loadTreeGames(store, OWNER, window, { color, timeClass: null });
    return [color, { games, analyses: games.map((game) => view.analysisOf(game)) }] as const;
  })
);

const coverageRows = COLORS.map((color) => {
  const { analyses } = byColor.get(color)!;
  const owner = analyses.reduce((sum, analysis) => sum + analysis.coverage.ownerMoves, 0);
  const scored = analyses.reduce((sum, analysis) => sum + analysis.coverage.scored, 0);
  return {
    colour: color,
    games: analyses.length,
    complete: analyses.filter((analysis) => analysis.status === "complete").length,
    "owner moves": owner,
    scored,
    pending: owner - scored
  };
});
console.log("\nCoverage (engine data for X of Y games = complete of games):");
printTable(coverageRows);

const classRows = COLORS.map((color) => {
  const counts = Object.fromEntries(MOVE_CATEGORIES.map((category) => [category, 0])) as Record<MoveCategory, number>;
  for (const analysis of byColor.get(color)!.analyses) {
    for (const move of analysis.ownerMoves) {
      if (move.status === "scored") {
        counts[move.cls] += 1;
      }
    }
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return { colour: color, scored: total, ...Object.fromEntries(MOVE_CATEGORIES.map((category) => [category, `${counts[category]} (${pct(total ? counts[category] / total : null)})`])) };
});
console.log("\nClass distribution of the owner's scored moves:");
printTable(classRows);

const mistakes = new Map<string, { color: PlayerColor; move: OwnerMoveScored; count: number }>();
for (const color of COLORS) {
  for (const analysis of byColor.get(color)!.analyses) {
    for (const move of analysis.ownerMoves) {
      if (move.status === "scored" && (move.cls === "mistake" || move.cls === "blunder")) {
        const key = `${color}|${move.epdBefore}|${move.uci}`;
        const entry = mistakes.get(key) ?? { color, move, count: 0 };
        entry.count += 1;
        mistakes.set(key, entry);
      }
    }
  }
}
console.log("\nThe 10 most frequent owner mistakes (or worse):");
printTable(
  [...mistakes.values()]
    .sort((a, b) => b.count - a.count || b.move.loss - a.move.loss)
    .slice(0, 10)
    .map(({ color, move, count }) => ({
      colour: color,
      epd: move.epdBefore.slice(0, 44),
      move: formatLine([move.san], move.ply),
      best: formatLine([move.bestSan], move.ply),
      loss: move.loss,
      class: move.cls,
      count
    }))
);

console.log("\nGames with a first mistake by ply 10 / 15 / 20 (over the games where it is known):");
printTable(
  COLORS.map((color) => {
    const shares = firstErrorShares(byColor.get(color)!.analyses, [10, 15, 20]);
    return {
      colour: color,
      ...Object.fromEntries(shares.map((share) => [`by ${share.ply}`, `${pct(share.rate)} (${share.errors}/${share.known} of ${share.games})`]))
    };
  })
);
console.log("  Audit baseline (other thresholds): Black 34/54/74%, White 12/40/57%.");

// ---- Payload sanity -------------------------------------------------------------------------
for (const color of COLORS) {
  for (const analysis of byColor.get(color)!.analyses) {
    for (const point of analysis.evalWhite) {
      if (point !== "pending") {
        check(Number.isFinite(point.cp) && Math.abs(point.cp) <= 1000, `${analysis.gameId}: eval ${point.cp} beyond +/-10.00`);
        check(point.mate === null || Math.abs(point.mate) < 100, `${analysis.gameId}: mate ${point.mate}`);
      }
    }
    for (const move of analysis.ownerMoves) {
      if (move.status === "scored") {
        check(move.loss >= 0 && move.loss <= 95.1 && Number.isFinite(move.loss), `${analysis.gameId} ply ${move.ply}: loss ${move.loss}`);
      }
    }
  }
}

// ---- The 2...Bc5 and Albin acceptance -----------------------------------------------------------
function lineReport(name: string, line: { color: PlayerColor; moves: string[] }) {
  const plies = replayUciSans(line.moves);
  const last = plies[plies.length - 1];
  const verdict = rootVerdict(view.lookup(last.epdBefore, "owner"), last.uci);
  const reply = view.lookup(last.epdAfter, "opponent")?.lines[0];
  const games = byColor
    .get(line.color)!
    .analyses.filter((analysis) => {
      const move = analysis.ownerMoves.find((entry) => entry.ply === plies.length);
      return move?.epdBefore === last.epdBefore && move.uci === last.uci;
    });
  const classes = games.map((analysis) => analysis.ownerMoves.find((entry) => entry.ply === plies.length)!);
  const line_ = formatLine(plies.map((ply) => ply.san));
  if (!verdict) {
    check(false, `${name}: ${line_} is not scored in the cache`);
    return null;
  }
  const bestSan = sanOf(last.epdBefore, verdict.best.uci);
  console.log(
    `\n${name}: ${line_} (${games.length} games as ${line.color}) · loss ${verdict.loss.toFixed(1)} win% · ` +
      `best ${bestSan} (${verdict.best.cp ?? `M${verdict.best.mate}`} cp for the side to move) vs ${last.san} (${verdict.played.cp ?? `M${verdict.played.mate}`} cp)` +
      (reply ? ` · reply ${sanOf(last.epdAfter, reply.uci)} ${reply.cp ?? `M${reply.mate}`} cp for the opponent` : " · reply not analysed") +
      ` · classes in the games: ${[...new Set(classes.map((move) => (move.status === "scored" ? move.cls : "pending")))].join(", ")}`
  );
  return { verdict, bestSan, reply, games, classes };
}

const bc5 = lineReport("2...Bc5", LINES.bc5);
if (bc5) {
  check(bc5.verdict.loss >= 8, `2...Bc5 loses ${bc5.verdict.loss.toFixed(2)} win%, expected >= 8`);
  check(["Nc6", "Nf6", "d6"].includes(bc5.bestSan), `2...Bc5: best is ${bc5.bestSan}, expected Nc6, Nf6 or d6`);
  check(bc5.reply?.uci === "f3e5", `2...Bc5: White's best reply is ${bc5.reply?.uci ?? "not analysed"}, expected 3.Nxe5`);
  check(bc5.games.length > 0, "2...Bc5: no game as Black plays it in the window");
  check(
    bc5.classes.every((move) => move.status === "scored" && move.loss >= 8),
    "2...Bc5: every game's ply 4 is scored with loss >= 8 (one EPD, one eval)"
  );
}
const albin = lineReport("Albin", LINES.albin);
if (albin) {
  check(albin.verdict.loss < ENGINE_HOLE_MIN_LOSS, `Albin 2...e5 loses ${albin.verdict.loss.toFixed(2)} win%: it would pass the engine-hole loss gate`);
}

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const failure of failures.slice(0, 30)) {
    console.error(`  - ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("\nverify-analysis: OK");
}
store.close();

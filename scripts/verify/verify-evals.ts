// Verify the engine backfill (P4b): npx tsx scripts/verify/verify-evals.ts [--games N]
// Read-only on storage/chess.db. It
// 1. reports coverage (games analysed per colour, positions per tier, mean nodes) and the
//    throughput the backfill runs measured (nps, time per game), to calibrate the ETA;
// 2. checks every analysed game of the current engine config: all its positions are in the
//    store with the played move scored, and its summary is sane (no NaN, losses in [0, 95.1]);
// 3. on a temporary copy of the database, with a sample of the N newest window games (default
//    5; unanalysed ones are backfilled in the copy first, with the real engine):
//    - cache hits: with the sample's game_analysis rows deleted, a backfill redoes the games
//      from the position cache with an engine pool that fails on any search;
//    - the INCREMENTAL RULE: a second run analyses 0 games;
//    - a review of a sample game is built from the cache alone;
//    - a new engine config (another protocol) re-queues the whole window and keeps the old rows.
// The copy is deleted afterwards. Every Stockfish process it starts is closed before it exits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import type { GameOpeningSummary, OpeningSideSummary } from "../../shared/types.js";
import { windowBounds } from "../../shared/window.js";
import { config } from "../../server/config.js";
import { lastMeasuredRun } from "../../server/db/backfillRuns.js";
import { openDatabase, type Db } from "../../server/db/connection.js";
import { getOrCreateEngineConfig } from "../../server/db/engineConfigs.js";
import { analysisCoverage, countAnalysisQueue } from "../../server/db/gameAnalysis.js";
import { listOpeningMoves } from "../../server/db/games.js";
import { averageNodes, getPositionEval, windowPositionCoverage } from "../../server/db/positions.js";
import { currentEngineConfig, engineConfigKey } from "../../server/engine/engineConfig.js";
import { EnginePool, type PoolStats } from "../../server/engine/pool.js";
import { ENGINE_PROTOCOL, canonicalJson } from "../../server/engine/protocol.js";
import { engineOptions } from "../../server/engine/sharedPool.js";
import { UciEngine, detectEngineId } from "../../server/engine/uci.js";
import { runBackfill, type BackfillPool } from "../../server/services/backfill.js";
import { isAnswered, openingPositions } from "../../server/services/openingPass.js";
import { cachedGameReview } from "../../server/services/reviewAnalysis.js";
import { OWNER, argValue, openStoreReadonly, printTable } from "./_lib.js";

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) {
    failures.push(message);
  }
};
const fmt = (value: number) => Math.round(value).toLocaleString("en-US");
const sampleSize = Number(argValue("games") ?? 5);
if (!Number.isInteger(sampleSize) || sampleSize < 1) {
  throw new Error("--games needs a positive whole number");
}

const idName = await detectEngineId(engineOptions());
const windowStart = windowBounds(Math.floor(Date.now() / 1000)).start;
const query = (configId: number) => ({ username: OWNER, configId, windowStart, openingPlies: OPENING_PLY_LIMIT });

// ---- 1 + 2: the real store, read-only ----------------------------------------------------
const store = openStoreReadonly();
// The config the app would use: the detected engine version with the current protocol.
const configRow = store
  .prepare("SELECT id FROM engine_configs WHERE engine_version = ? AND protocol_json = ?")
  .get(engineConfigKey(idName).engineVersion, canonicalJson(ENGINE_PROTOCOL)) as { id: number } | undefined;
const configId = configRow?.id ?? -1;
console.log(`Engine ${idName} · config #${configId === -1 ? "(none yet)" : configId} · window from ${new Date(windowStart * 1000).toISOString().slice(0, 10)}`);

const coverage = analysisCoverage(store, query(configId));
const positions = windowPositionCoverage(store, query(configId));
const nodes = averageNodes(store, configId);
printTable(
  (["white", "black"] as const).map((color) => ({ colour: color, games: coverage[color].total, analysed: coverage[color].analysed }))
);
printTable(
  (["owner", "opponent"] as const).map((tier) => ({
    tier,
    positions: positions[tier].total,
    cached: positions[tier].cached,
    rows: nodes[tier].n,
    meanNodes: fmt(nodes[tier].mean)
  }))
);
const measured = lastMeasuredRun(store);
if (measured) {
  const wallSec = ((measured.finishedAt ?? measured.startedAt) - measured.startedAt) / 1000;
  const nps = (measured.nodes / measured.searchMs) * 1000;
  console.log(
    `Last measured run #${measured.id} (${measured.source}, ${measured.workers} workers, ${measured.onBattery ? "battery" : "mains"}): ` +
      `${measured.gamesDone} games in ${wallSec.toFixed(0)} s (${(wallSec / Math.max(1, measured.gamesDone)).toFixed(1)} s per game), ` +
      `${fmt(measured.positionsSearched)} positions, ${(measured.nodes / 1e6).toFixed(0)}M nodes, ${(nps / 1e6).toFixed(2)} Mnps pool-wide.`
  );
} else {
  console.log("No backfill run has measured throughput yet.");
}

// Every analysed game under the current config: positions stored and scored, summary sane.
const moves = listOpeningMoves(store, OWNER, windowStart, OPENING_PLY_LIMIT);
const rows = store.prepare("SELECT game_id, plies, summary_json FROM game_analysis WHERE config_id = ?").all(configId) as {
  game_id: string;
  plies: number;
  summary_json: string;
}[];
let checkedMoves = 0;
const sideOk = (side: OpeningSideSummary) =>
  [side.avgLoss, side.accuracy, side.worst?.lossWinPct ?? 0, side.firstError?.lossWinPct ?? 0].every(
    (value) => Number.isFinite(value) && value >= 0 && value <= 100
  ) && (side.worst?.lossWinPct ?? 0) <= 95.1;
for (const row of rows) {
  const game = moves.get(row.game_id);
  if (!game) {
    continue; // analysed, but outside the window now
  }
  const gamePositions = openingPositions(game.plies, game.color);
  check(row.plies === gamePositions.length, `${row.game_id}: plies ${row.plies}, expected ${gamePositions.length}`);
  for (const position of gamePositions) {
    checkedMoves += 1;
    const stored = getPositionEval(store, configId, position.epd, position.tier);
    check(Boolean(stored) && isAnswered(stored, [position.played]), `${row.game_id} ply ${position.ply}: ${position.san} not scored in the store`);
    for (const line of stored ? [...stored.lines, ...stored.scored] : []) {
      check(Number.isFinite(line.winPct), `${row.game_id} ply ${position.ply}: NaN win%`);
    }
  }
  const summary = JSON.parse(row.summary_json) as GameOpeningSummary;
  check(summary.version === 1 && summary.color === game.color && summary.plies === gamePositions.length, `${row.game_id}: summary header`);
  check(summary.owner.moves + summary.opponent.moves === gamePositions.length, `${row.game_id}: summary move counts`);
  check(sideOk(summary.owner) && sideOk(summary.opponent), `${row.game_id}: summary losses out of range`);
  check(summary.evalAfter.every((entry) => Number.isFinite(entry.cp) && entry.winPct >= 0 && entry.winPct <= 100), `${row.game_id}: evalAfter`);
}
console.log(`Checked ${fmt(rows.length)} analysed game(s), ${fmt(checkedMoves)} moves: every move scored in the store.`);

// ---- 3: the sample, on a copy ------------------------------------------------------------
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-evals-"));
const copyPath = path.join(tempDir, "chess.db");
await store.backup(copyPath);
store.close();
const db: Db = openDatabase(copyPath);
const pool = new EnginePool({ size: config.engineWorkers, spawn: () => UciEngine.start(engineOptions()) });

try {
  const current = currentEngineConfig(db, idName);
  const sample = db
    .prepare("SELECT id, end_time FROM games WHERE username = ? AND end_time >= ? ORDER BY end_time DESC, id DESC LIMIT ?")
    .all(OWNER, windowStart, sampleSize) as { id: string; end_time: number }[];
  const sampleStart = sample[sample.length - 1].end_time;
  const sampleIds = sample.map((game) => game.id);
  const inSample = `game_id IN (${sampleIds.map(() => "?").join(", ")})`;
  const run = (backfillPool: BackfillPool) =>
    runBackfill({ db, pool: backfillPool, owner: OWNER, source: "cli" }, { windowStart: sampleStart, limit: sampleSize });

  // Backfill any unanalysed sample game (in the copy only).
  const missing = countAnalysisQueue(db, { ...query(current.id), windowStart: sampleStart });
  if (missing) {
    const started = Date.now();
    const result = await run(pool);
    console.log(`Backfilled ${result.gamesAnalysed} unanalysed sample game(s) in the copy (${((Date.now() - started) / 1000).toFixed(1)} s).`);
    check(result.status === "completed", `sample backfill: ${result.status} ${result.errors.join("; ")}`);
  }

  // A pool that may not search: every answer has to come from the position cache.
  let attempted = 0;
  const noSearch: BackfillPool = {
    engineIdName: async () => idName,
    stats: (): PoolStats => ({ size: 3, engines: 0, busy: 0, queued: { interactive: 0, backfill: 0 } }),
    analyseGame: async () => {
      attempted += 1;
      throw new Error("verify-evals: a search was attempted although the cache should answer");
    }
  };

  const before = db.prepare(`SELECT game_id, summary_json FROM game_analysis WHERE config_id = ? AND ${inSample} ORDER BY game_id`).all(current.id, ...sampleIds);
  db.prepare(`DELETE FROM game_analysis WHERE config_id = ? AND ${inSample}`).run(current.id, ...sampleIds);
  const redo = await run(noSearch);
  const after = db.prepare(`SELECT game_id, summary_json FROM game_analysis WHERE config_id = ? AND ${inSample} ORDER BY game_id`).all(current.id, ...sampleIds);
  printTable([
    { step: "redo from cache", games: redo.gamesAnalysed, searched: redo.positionsSearched, attempted, cachedPositions: redo.progress.positions.cached, status: redo.status }
  ]);
  check(redo.gamesAnalysed === sample.length && redo.positionsSearched === 0 && attempted === 0, "cache hits: the sample was not redone from the cache alone");
  check(JSON.stringify(after) === JSON.stringify(before), "cache hits: the redone summaries differ from the originals");

  const again = await run(noSearch);
  printTable([{ step: "second run", games: again.gamesAnalysed, searched: again.positionsSearched, queued: again.progress.games.total }]);
  check(again.gamesAnalysed === 0 && again.progress.games.total === 0 && again.positionsSearched === 0, "incremental rule: a second run analysed games");

  const reviewStarted = performance.now();
  const review = cachedGameReview(db, sampleIds[0], current.id);
  const reviewMs = performance.now() - reviewStarted;
  console.log(`Review of ${sampleIds[0]} from the cache: ${review ? `${review.moves.length} moves in ${reviewMs.toFixed(1)} ms` : "NOT cached"}.`);
  check(Boolean(review) && review!.moves.length === Math.min(OPENING_PLY_LIMIT, moves.get(sampleIds[0])?.plies.length ?? 0), "the cached review is incomplete");

  const oldRows = (db.prepare("SELECT COUNT(*) AS n FROM game_analysis WHERE config_id = ?").get(current.id) as { n: number }).n;
  const oldQueue = countAnalysisQueue(db, query(current.id));
  const changed = getOrCreateEngineConfig(db, engineConfigKey(idName, { ...ENGINE_PROTOCOL, version: 999 } as unknown as typeof ENGINE_PROTOCOL));
  const newQueue = countAnalysisQueue(db, query(changed.id));
  const windowGames = coverage.white.total + coverage.black.total;
  printTable([{ step: "new config", config: changed.id, queued: newQueue, windowGames, oldConfigQueued: oldQueue, oldRowsKept: oldRows }]);
  check(changed.id !== current.id, "a changed protocol did not create a new engine config");
  check(newQueue === windowGames, `a new config should re-queue all ${windowGames} window games, got ${newQueue}`);
  check(countAnalysisQueue(db, query(current.id)) === oldQueue, "the old config's queue changed");
  check(
    (db.prepare("SELECT COUNT(*) AS n FROM game_analysis WHERE config_id = ?").get(current.id) as { n: number }).n === oldRows,
    "the old config's rows were not kept"
  );
} finally {
  await pool.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\nverify-evals FAILED (${failures.length}):`);
  for (const failure of failures.slice(0, 30)) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}
console.log("\nverify-evals OK");

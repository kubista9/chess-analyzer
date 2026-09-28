import type { BackfillRun, BackfillRunStatus } from "../../shared/types.js";
import type { Db } from "./connection.js";

// backfill_runs: one row per backfill run, CLI or server. The measured throughput of the
// last real run feeds the next estimate (--dry-run, the Home card).

interface RunRow {
  id: number;
  source: "cli" | "server";
  config_id: number;
  workers: number;
  on_battery: number | null;
  started_at: number;
  finished_at: number | null;
  status: BackfillRunStatus;
  games_queued: number;
  games_done: number;
  games_failed: number;
  positions_searched: number;
  nodes: number;
  search_ms: number;
  error: string | null;
}

function toRun(row: RunRow): BackfillRun {
  return {
    id: row.id,
    source: row.source,
    configId: row.config_id,
    workers: row.workers,
    onBattery: row.on_battery === null ? null : row.on_battery === 1,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    gamesQueued: row.games_queued,
    gamesDone: row.games_done,
    gamesFailed: row.games_failed,
    positionsSearched: row.positions_searched,
    nodes: row.nodes,
    searchMs: row.search_ms,
    error: row.error
  };
}

export interface NewBackfillRun {
  source: "cli" | "server";
  pid: number;
  configId: number;
  workers: number;
  onBattery: boolean | null;
  startedAt: number;
  gamesQueued: number;
}

export function insertBackfillRun(db: Db, run: NewBackfillRun): number {
  const result = db
    .prepare(
      `INSERT INTO backfill_runs (source, pid, config_id, workers, on_battery, started_at, status, games_queued)
       VALUES (@source, @pid, @configId, @workers, @onBattery, @startedAt, 'running', @gamesQueued)`
    )
    .run({ ...run, onBattery: run.onBattery === null ? null : Number(run.onBattery) });
  return Number(result.lastInsertRowid);
}

export interface BackfillRunUpdate {
  status: BackfillRunStatus;
  finishedAt: number | null;
  gamesDone: number;
  gamesFailed: number;
  positionsSearched: number;
  nodes: number;
  searchMs: number;
  error: string | null;
}

export function updateBackfillRun(db: Db, id: number, update: BackfillRunUpdate): void {
  db.prepare(
    `UPDATE backfill_runs SET status = @status, finished_at = @finishedAt, games_done = @gamesDone,
       games_failed = @gamesFailed, positions_searched = @positionsSearched, nodes = @nodes,
       search_ms = @searchMs, error = @error
     WHERE id = @id`
  ).run({ id, ...update });
}

/** The most recent finished run (any status but running), or undefined. */
export function lastBackfillRun(db: Db): BackfillRun | undefined {
  const row = db.prepare("SELECT * FROM backfill_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1").get() as
    | RunRow
    | undefined;
  return row ? toRun(row) : undefined;
}

/**
 * The most recent completed run that searched long enough to measure throughput (at least
 * `minMs` of searching), or undefined. Its nodes / searchMs is this machine's pool-wide speed.
 * Paused runs are left out: their ramp-up and drain (fewer busy workers) understate it.
 */
export function lastMeasuredRun(db: Db, minMs = 10_000): BackfillRun | undefined {
  const row = db
    .prepare(
      `SELECT * FROM backfill_runs
       WHERE status = 'completed' AND finished_at IS NOT NULL AND search_ms >= ? AND nodes > 0
       ORDER BY id DESC LIMIT 1`
    )
    .get(minMs) as RunRow | undefined;
  return row ? toRun(row) : undefined;
}

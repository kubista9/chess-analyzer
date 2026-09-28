import type { Db } from "./connection.js";

export interface SyncRunRow<T = unknown> {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  summary: T | null;
}

export function startSyncRun(db: Db, username: string, at: number): number {
  return Number(db.prepare("INSERT INTO sync_runs (username, started_at) VALUES (?, ?)").run(username, at).lastInsertRowid);
}

export function finishSyncRun(db: Db, id: number, at: number, ok: boolean, summary: unknown): void {
  db.prepare("UPDATE sync_runs SET finished_at = ?, ok = ?, summary_json = ? WHERE id = ?").run(
    at,
    ok ? 1 : 0,
    JSON.stringify(summary),
    id
  );
}

/** The most recent finished run, or undefined. `okOnly` skips failed runs. */
export function lastSyncRun<T>(db: Db, username: string, okOnly = false): SyncRunRow<T> | undefined {
  const row = db
    .prepare(
      `SELECT id, started_at, finished_at, ok, summary_json FROM sync_runs
       WHERE username = ? AND finished_at IS NOT NULL ${okOnly ? "AND ok = 1" : ""}
       ORDER BY finished_at DESC, id DESC LIMIT 1`
    )
    .get(username) as
    | { id: number; started_at: number; finished_at: number | null; ok: number | null; summary_json: string | null }
    | undefined;

  return (
    row && {
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      ok: row.ok === null ? null : row.ok === 1,
      summary: row.summary_json ? (JSON.parse(row.summary_json) as T) : null
    }
  );
}

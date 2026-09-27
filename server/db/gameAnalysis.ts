import type { PlayerColor } from "../../shared/types.js";
import type { Db } from "./connection.js";

// game_analysis rows mean "this game's opening is fully analysed under this engine config".
// INCREMENTAL RULE: a game with a row for the current config is never analysed again. The
// work queue is every window game without such a row, newest first. A new engine config
// (binary, version or protocol) therefore re-queues the whole window by itself, and the rows
// of old configs are kept. A row covering fewer plies than the current opening window (and
// than the game has) does not count, so raising the window re-queues only what it adds to.

export interface GameAnalysisRecord {
  gameId: string;
  configId: number;
  plies: number;
  analyzedAt: number;
  summary: unknown;
}

export function recordGameAnalysis(db: Db, record: GameAnalysisRecord): void {
  db.prepare(
    `INSERT INTO game_analysis (game_id, config_id, plies, analyzed_at, summary_json)
     VALUES (@gameId, @configId, @plies, @analyzedAt, @summaryJson)
     ON CONFLICT (game_id, config_id) DO UPDATE SET
       plies = excluded.plies, analyzed_at = excluded.analyzed_at, summary_json = excluded.summary_json`
  ).run({
    gameId: record.gameId,
    configId: record.configId,
    plies: record.plies,
    analyzedAt: record.analyzedAt,
    summaryJson: JSON.stringify(record.summary ?? null)
  });
}

export function getGameAnalysis(db: Db, gameId: string, configId: number): GameAnalysisRecord | undefined {
  const row = db
    .prepare("SELECT game_id, config_id, plies, analyzed_at, summary_json FROM game_analysis WHERE game_id = ? AND config_id = ?")
    .get(gameId, configId) as
    | { game_id: string; config_id: number; plies: number; analyzed_at: number; summary_json: string }
    | undefined;
  return row
    ? {
        gameId: row.game_id,
        configId: row.config_id,
        plies: row.plies,
        analyzedAt: row.analyzed_at,
        summary: JSON.parse(row.summary_json)
      }
    : undefined;
}

export interface AnalysisQueueQuery {
  username: string;
  configId: number;
  /** Unix seconds, inclusive. */
  windowStart: number;
  /** Unix seconds, inclusive; defaults to no upper bound. */
  windowEnd?: number;
  /** The current opening window (OPENING_PLY_LIMIT). */
  openingPlies: number;
  limit?: number;
}

export interface QueuedGame {
  id: string;
  endTime: number;
  color: PlayerColor;
  plyCount: number;
}

const QUEUE_WHERE = `
  FROM games g
  LEFT JOIN game_analysis a ON a.game_id = g.id AND a.config_id = @configId
  WHERE g.username = @username
    AND g.end_time >= @windowStart AND (@windowEnd IS NULL OR g.end_time <= @windowEnd)
    AND (a.game_id IS NULL OR a.plies < MIN(@openingPlies, g.ply_count))`;

function queueParams(query: AnalysisQueueQuery) {
  return {
    username: query.username,
    configId: query.configId,
    windowStart: query.windowStart,
    windowEnd: query.windowEnd ?? null,
    openingPlies: query.openingPlies
  };
}

/** The games still to analyse under a config, newest first. */
export function listAnalysisQueue(db: Db, query: AnalysisQueueQuery): QueuedGame[] {
  const rows = db
    .prepare(
      `SELECT g.id, g.end_time, g.color, g.ply_count ${QUEUE_WHERE}
       ORDER BY g.end_time DESC, g.id DESC
       LIMIT @limit`
    )
    .all({ ...queueParams(query), limit: query.limit ?? -1 }) as { id: string; end_time: number; color: string; ply_count: number }[];
  return rows.map((row) => ({ id: row.id, endTime: row.end_time, color: row.color as PlayerColor, plyCount: row.ply_count }));
}

export function countAnalysisQueue(db: Db, query: AnalysisQueueQuery): number {
  return (db.prepare(`SELECT COUNT(*) AS n ${QUEUE_WHERE}`).get(queueParams(query)) as { n: number }).n;
}

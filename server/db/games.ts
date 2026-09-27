import type { DerivedGame } from "../services/gameDerive.js";
import type { GameRecord, GameResult, ImportedTimeClass, OpeningPly, PlayerColor } from "../../shared/types.js";
import type { WindowBounds } from "../../shared/window.js";
import type { Db } from "./connection.js";

export type GameSource = "archive" | "raw-games-seed";

interface GameRow {
  id: string;
  uuid: string | null;
  url: string;
  month: string;
  end_time: number;
  time_class: string;
  time_control: string;
  tc_base: number | null;
  tc_inc: number | null;
  rated: number;
  color: string;
  result: string;
  result_code: string;
  score: number;
  my_rating: number;
  opp_rating: number;
  opp_name: string;
  eco: string | null;
  eco_url: string | null;
  opening_name: string;
  termination: string | null;
  ply_count: number;
  derive_version: number;
}

function toRecord(row: GameRow): GameRecord {
  return {
    id: row.id,
    uuid: row.uuid,
    url: row.url,
    month: row.month,
    endTime: row.end_time,
    timeClass: row.time_class as ImportedTimeClass,
    timeControl: row.time_control,
    tc: row.tc_base === null ? null : { base: row.tc_base, inc: row.tc_inc ?? 0 },
    rated: row.rated === 1,
    color: row.color as PlayerColor,
    result: row.result as GameResult,
    resultCode: row.result_code,
    score: row.score as GameRecord["score"],
    myRating: row.my_rating,
    oppRating: row.opp_rating,
    oppName: row.opp_name,
    eco: row.eco,
    ecoUrl: row.eco_url,
    openingName: row.opening_name,
    termination: row.termination,
    plyCount: row.ply_count,
    deriveVersion: row.derive_version
  };
}

/**
 * Replaces every game stored for (username, month), seeded or not, with `games`, in one
 * transaction. A game id seen in another month is moved here.
 */
export function replaceMonthGames(db: Db, username: string, month: string, games: DerivedGame[], source: GameSource): void {
  const deleteMonth = db.prepare("DELETE FROM games WHERE username = ? AND month = ?");
  const deleteGame = db.prepare("DELETE FROM games WHERE id = ?");
  const insertGame = db.prepare(
    `INSERT INTO games (id, uuid, username, source, url, month, end_time, time_class, time_control, tc_base, tc_inc,
       rated, color, result, result_code, score, my_rating, opp_rating, opp_name, eco, eco_url, opening_name,
       termination, ply_count, pgn, derive_version)
     VALUES (@id, @uuid, @username, @source, @url, @month, @endTime, @timeClass, @timeControl, @tcBase, @tcInc,
       @rated, @color, @result, @resultCode, @score, @myRating, @oppRating, @oppName, @eco, @ecoUrl, @openingName,
       @termination, @plyCount, @pgn, @deriveVersion)`
  );
  const insertPly = db.prepare(
    `INSERT INTO game_plies (game_id, ply, san, uci, epd_before, epd_after, clock_ms, spent_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  db.transaction(() => {
    deleteMonth.run(username, month);
    for (const { record, pgn, plies } of games) {
      deleteGame.run(record.id);
      insertGame.run({
        ...record,
        username,
        source,
        tcBase: record.tc?.base ?? null,
        tcInc: record.tc?.inc ?? null,
        rated: record.rated ? 1 : 0,
        pgn
      });
      for (const ply of plies) {
        insertPly.run(record.id, ply.ply, ply.san, ply.uci, ply.epdBefore, ply.epdAfter, ply.clockMs, ply.spentMs);
      }
    }
  })();
}

/** Months that already hold games from any source. */
export function monthsWithGames(db: Db, username: string): Set<string> {
  return new Set(
    (db.prepare("SELECT DISTINCT month FROM games WHERE username = ?").all(username) as { month: string }[]).map(
      (row) => row.month
    )
  );
}

export interface GameCounts {
  total: number;
  byTimeClass: Record<ImportedTimeClass, number>;
  byColor: Record<PlayerColor, number>;
  /** e.g. { "blitz|white": 612 } */
  byTimeClassColor: Record<string, number>;
  firstEndTime: number | null;
  lastEndTime: number | null;
}

/** Counts of the owner's stored games with start <= end_time <= end. */
export function countGames(db: Db, username: string, bounds: WindowBounds): GameCounts {
  const rows = db
    .prepare(
      `SELECT time_class, color, COUNT(*) AS n, MIN(end_time) AS first, MAX(end_time) AS last
       FROM games WHERE username = ? AND end_time BETWEEN ? AND ?
       GROUP BY time_class, color`
    )
    .all(username, bounds.start, bounds.end) as { time_class: ImportedTimeClass; color: PlayerColor; n: number; first: number; last: number }[];

  const counts: GameCounts = {
    total: 0,
    byTimeClass: { blitz: 0, rapid: 0 },
    byColor: { white: 0, black: 0 },
    byTimeClassColor: {},
    firstEndTime: null,
    lastEndTime: null
  };

  for (const row of rows) {
    counts.total += row.n;
    counts.byTimeClass[row.time_class] = (counts.byTimeClass[row.time_class] ?? 0) + row.n;
    counts.byColor[row.color] += row.n;
    counts.byTimeClassColor[`${row.time_class}|${row.color}`] = row.n;
    counts.firstEndTime = counts.firstEndTime === null ? row.first : Math.min(counts.firstEndTime, row.first);
    counts.lastEndTime = counts.lastEndTime === null ? row.last : Math.max(counts.lastEndTime, row.last);
  }

  return counts;
}

/** Stored games per (month, time_class), for every month. */
export function countGamesByMonth(db: Db, username: string): { month: string; time_class: string; source: string; n: number }[] {
  return db
    .prepare(
      `SELECT month, time_class, source, COUNT(*) AS n FROM games WHERE username = ?
       GROUP BY month, time_class, source ORDER BY month, time_class`
    )
    .all(username) as { month: string; time_class: string; source: string; n: number }[];
}

export function getGame(db: Db, id: string): GameRecord | undefined {
  const row = db.prepare("SELECT * FROM games WHERE id = ?").get(id) as GameRow | undefined;
  return row && toRecord(row);
}

/** The owner's games in the window, newest first. */
export function listGames(db: Db, username: string, bounds: WindowBounds): GameRecord[] {
  return (
    db
      .prepare("SELECT * FROM games WHERE username = ? AND end_time BETWEEN ? AND ? ORDER BY end_time DESC, id DESC")
      .all(username, bounds.start, bounds.end) as GameRow[]
  ).map(toRecord);
}

/** The stored opening plies of one game (at most DERIVE_PLY_LIMIT), in order. */
export function getGamePlies(db: Db, id: string): OpeningPly[] {
  const rows = db
    .prepare("SELECT ply, san, uci, epd_before, epd_after, clock_ms, spent_ms FROM game_plies WHERE game_id = ? ORDER BY ply")
    .all(id) as {
    ply: number;
    san: string;
    uci: string;
    epd_before: string;
    epd_after: string;
    clock_ms: number | null;
    spent_ms: number | null;
  }[];

  return rows.map((row) => ({
    ply: row.ply,
    san: row.san,
    uci: row.uci,
    epdBefore: row.epd_before,
    epdAfter: row.epd_after,
    clockMs: row.clock_ms,
    spentMs: row.spent_ms
  }));
}

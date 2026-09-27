import type { DerivedGame } from "../services/gameDerive.js";
import type { GameCounts, GameRecord, GameResult, OpeningPly, PlayerColor, TimeClass, TreeGameRow } from "../../shared/types.js";
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
    timeClass: row.time_class as TimeClass,
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

/** Counts of the owner's stored games with start <= end_time <= end. */
export function countGames(db: Db, username: string, bounds: WindowBounds): GameCounts {
  const rows = db
    .prepare(
      `SELECT time_class, color, COUNT(*) AS n, MIN(end_time) AS first, MAX(end_time) AS last
       FROM games WHERE username = ? AND end_time BETWEEN ? AND ?
       GROUP BY time_class, color`
    )
    .all(username, bounds.start, bounds.end) as { time_class: TimeClass; color: PlayerColor; n: number; first: number; last: number }[];

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

export interface GameFilter {
  timeClass?: TimeClass;
  color?: PlayerColor;
}

/** The owner's games in the window (optionally one time class and/or colour), newest first. */
export function listGames(db: Db, username: string, bounds: WindowBounds, filter: GameFilter = {}): GameRecord[] {
  return (
    db
      .prepare(
        `SELECT * FROM games WHERE username = @username AND end_time BETWEEN @start AND @end
           AND (@timeClass IS NULL OR time_class = @timeClass) AND (@color IS NULL OR color = @color)
         ORDER BY end_time DESC, id DESC`
      )
      .all({
        username,
        start: bounds.start,
        end: bounds.end,
        timeClass: filter.timeClass ?? null,
        color: filter.color ?? null
      }) as GameRow[]
  ).map(toRecord);
}

/**
 * Slim rows for the games `ids` (in the order given; unknown ids are skipped), each with the
 * first ply at which the game played `uci` from `epdBefore`.
 */
export function listMoveGames(db: Db, ids: readonly string[], epdBefore: string, uci: string): TreeGameRow[] {
  if (!ids.length) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT g.id, g.url, g.end_time, g.time_class, g.time_control, g.result, g.my_rating, g.opp_name, g.opp_rating,
         (SELECT MIN(p.ply) FROM game_plies p WHERE p.game_id = g.id AND p.epd_before = @epd AND p.uci = @uci) AS ply
       FROM games g WHERE g.id IN (SELECT value FROM json_each(@ids))`
    )
    .all({ ids: JSON.stringify(ids), epd: epdBefore, uci }) as {
    id: string;
    url: string;
    end_time: number;
    time_class: string;
    time_control: string;
    result: string;
    my_rating: number;
    opp_name: string;
    opp_rating: number;
    ply: number | null;
  }[];

  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row
      ? [
          {
            id: row.id,
            url: row.url,
            endTime: row.end_time,
            timeClass: row.time_class as TimeClass,
            timeControl: row.time_control,
            result: row.result as GameResult,
            myRating: row.my_rating,
            oppName: row.opp_name,
            oppRating: row.opp_rating,
            ply: row.ply
          }
        ]
      : [];
  });
}

/** The full PGN of a stored game (the review replays it). */
export function getGamePgn(db: Db, id: string): string | undefined {
  return (db.prepare("SELECT pgn FROM games WHERE id = ?").get(id) as { pgn: string } | undefined)?.pgn;
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

/**
 * The opening plies (ply <= maxPly) of the owner's games in the window, by game id, in ply
 * order. One query, so the tree needs no per-game round trips and no replay.
 */
export function listOpeningPlies(
  db: Db,
  username: string,
  bounds: WindowBounds,
  filter: GameFilter,
  maxPly: number
): Map<string, OpeningPly[]> {
  const rows = db
    .prepare(
      `SELECT p.game_id, p.ply, p.san, p.uci, p.epd_before, p.epd_after, p.clock_ms, p.spent_ms
       FROM game_plies p JOIN games g ON g.id = p.game_id
       WHERE g.username = @username AND g.end_time BETWEEN @start AND @end
         AND (@timeClass IS NULL OR g.time_class = @timeClass) AND (@color IS NULL OR g.color = @color)
         AND p.ply <= @maxPly
       ORDER BY p.game_id, p.ply`
    )
    .all({
      username,
      start: bounds.start,
      end: bounds.end,
      timeClass: filter.timeClass ?? null,
      color: filter.color ?? null,
      maxPly
    }) as {
    game_id: string;
    ply: number;
    san: string;
    uci: string;
    epd_before: string;
    epd_after: string;
    clock_ms: number | null;
    spent_ms: number | null;
  }[];

  const byGame = new Map<string, OpeningPly[]>();
  for (const row of rows) {
    let plies = byGame.get(row.game_id);
    if (!plies) {
      plies = [];
      byGame.set(row.game_id, plies);
    }
    plies.push({
      ply: row.ply,
      san: row.san,
      uci: row.uci,
      epdBefore: row.epd_before,
      epdAfter: row.epd_after,
      clockMs: row.clock_ms,
      spentMs: row.spent_ms
    });
  }
  return byGame;
}

/** Every stored game's (id, time class, end time, post-game rating), for pre-game ratings. */
export function listRatingHistory(db: Db, username: string): { id: string; timeClass: string; endTime: number; myRating: number }[] {
  return db
    .prepare("SELECT id, time_class AS timeClass, end_time AS endTime, my_rating AS myRating FROM games WHERE username = ?")
    .all(username) as { id: string; timeClass: string; endTime: number; myRating: number }[];
}

/**
 * Changes whenever the owner's stored games may have changed: every sync (server or CLI, which
 * is also when months are re-derived) finishes a sync_runs row, and inserts take new rowids.
 * Cheap enough to check on every request.
 */
export function gamesStamp(db: Db, username: string): string {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS lastRow, COALESCE(MAX(end_time), 0) AS lastEnd,
         (SELECT COUNT(finished_at) FROM sync_runs) AS lastSync
       FROM games WHERE username = ?`
    )
    .get(username) as { n: number; lastRow: number; lastEnd: number; lastSync: number };
  return `${row.n}|${row.lastRow}|${row.lastEnd}|${row.lastSync}`;
}

export interface GameOpeningMoves {
  color: PlayerColor;
  endTime: number;
  plies: Pick<OpeningPly, "ply" | "san" | "uci" | "epdBefore">[];
}

/**
 * The opening moves (ply <= maxPly) of the owner's games that ended at or after
 * `windowStart`, by game id, in ply order: what the engine backfill plans its positions from.
 */
export function listOpeningMoves(db: Db, username: string, windowStart: number, maxPly: number): Map<string, GameOpeningMoves> {
  const rows = db
    .prepare(
      `SELECT p.game_id, g.color, g.end_time, p.ply, p.san, p.uci, p.epd_before
       FROM game_plies p JOIN games g ON g.id = p.game_id
       WHERE g.username = ? AND g.end_time >= ? AND p.ply <= ?
       ORDER BY p.game_id, p.ply`
    )
    .all(username, windowStart, maxPly) as {
    game_id: string;
    color: PlayerColor;
    end_time: number;
    ply: number;
    san: string;
    uci: string;
    epd_before: string;
  }[];

  const byGame = new Map<string, GameOpeningMoves>();
  for (const row of rows) {
    let game = byGame.get(row.game_id);
    if (!game) {
      game = { color: row.color, endTime: row.end_time, plies: [] };
      byGame.set(row.game_id, game);
    }
    game.plies.push({ ply: row.ply, san: row.san, uci: row.uci, epdBefore: row.epd_before });
  }
  return byGame;
}

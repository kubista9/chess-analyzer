import { z } from "zod";
import { IMPORTED_TIME_CLASSES, SKIP_REASONS } from "../../shared/constants.js";
import { normalizeResult, resolvePlayerColor } from "../../shared/chess.js";
import { START_EPD, toEpd } from "../../shared/epd.js";
import { parsePgnHeaders, parsePgnMoves, parseTimeControl, replayOpening, spentSeconds } from "../../shared/pgn.js";
import type { GameRecord, OpeningPly, SkipCounts, SkipReason, TimeClass } from "../../shared/types.js";

/** Bump when the derived columns or their meaning change; stale months are re-derived from raw_json. */
export const DERIVE_VERSION = 1;

/** Plies stored per game in game_plies. OPENING_PLY_LIMIT (20) is read from these. */
export const DERIVE_PLY_LIMIT = 30;


const playerSchema = z.looseObject({
  username: z.string(),
  rating: z.coerce.number().optional().default(0),
  result: z.string()
});

// A raw game from https://api.chess.com/pub/player/<user>/games/YYYY/MM. Unknown fields pass.
export const rawGameSchema = z.looseObject({
  url: z.string(),
  pgn: z.string(),
  end_time: z.number(),
  time_class: z.string(),
  time_control: z.string().optional().default("?"),
  rated: z.boolean().optional().default(false),
  uuid: z.string().optional(),
  rules: z.string().optional(),
  initial_setup: z.string().optional(),
  eco: z.string().nullable().optional(),
  white: playerSchema,
  black: playerSchema
});
export type RawGame = z.infer<typeof rawGameSchema>;

export interface DerivedGame {
  record: GameRecord;
  pgn: string;
  plies: OpeningPly[];
}

export interface DerivedMonth {
  games: DerivedGame[];
  skipped: SkipCounts;
}

export function emptySkipCounts(): SkipCounts {
  return Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as SkipCounts;
}

export function gameIdFromUrl(url: string): string {
  return url.split("/").filter(Boolean).at(-1) ?? url;
}

/** "YYYY-MM" of a Unix-seconds timestamp, in UTC. */
export function utcMonth(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 7);
}

function openingNameFromEcoUrl(ecoUrl: string | null | undefined): string {
  if (!ecoUrl) {
    return "Unknown opening";
  }
  try {
    const slug = new URL(ecoUrl).pathname.split("/").filter(Boolean).at(-1);
    return slug ? decodeURIComponent(slug).replace(/-/g, " ") : "Unknown opening";
  } catch {
    return "Unknown opening";
  }
}

function isStandardSetup(initialSetup: string | undefined): boolean {
  return !initialSetup || toEpd(initialSetup) === START_EPD;
}

/**
 * Why a raw game is not imported, or null when it is kept. The order matters for the
 * per-reason counters: a chess960 game (which also has SetUp/FEN) counts as 'variant'.
 */
export function skipReason(owner: string, game: RawGame, headers = parsePgnHeaders(game.pgn)): SkipReason | null {
  if ((game.rules ?? "chess") !== "chess" || (headers.Variant && headers.Variant !== "Standard")) {
    return "variant";
  }
  if (!isStandardSetup(game.initial_setup) || headers.SetUp === "1" || headers.FEN !== undefined) {
    return "custom-start";
  }
  if (!(IMPORTED_TIME_CLASSES as readonly string[]).includes(game.time_class)) {
    return "time-class";
  }
  if (!resolvePlayerColor(owner, game.white.username, game.black.username)) {
    return "not-owner";
  }
  return null;
}

/** Derives one kept game. Throws when the PGN cannot be replayed. */
export function deriveGame(owner: string, month: string, game: RawGame, headers = parsePgnHeaders(game.pgn)): DerivedGame {
  const color = resolvePlayerColor(owner, game.white.username, game.black.username);
  if (!color) {
    throw new Error(`${game.url} was not played by ${owner}`);
  }

  const me = color === "white" ? game.white : game.black;
  const opp = color === "white" ? game.black : game.white;
  const result = normalizeResult(color, game.white.result, game.black.result);
  const moves = parsePgnMoves(game.pgn);
  const tc = parseTimeControl(headers.TimeControl ?? game.time_control);
  const spent = spentSeconds(
    moves.map((move) => move.clockSec),
    tc
  );
  const replayed = replayOpening(
    moves.map((move) => move.san),
    DERIVE_PLY_LIMIT
  );
  const toMs = (seconds: number | null) => (seconds === null ? null : Math.round(seconds * 1000));

  return {
    record: {
      id: gameIdFromUrl(game.url),
      uuid: game.uuid ?? null,
      url: game.url,
      month,
      endTime: game.end_time,
      timeClass: game.time_class as TimeClass,
      timeControl: game.time_control,
      tc,
      rated: game.rated,
      color,
      result,
      resultCode: me.result,
      score: result === "win" ? 1 : result === "draw" ? 0.5 : 0,
      myRating: me.rating,
      oppRating: opp.rating,
      oppName: opp.username.trim(),
      eco: headers.ECO ?? null,
      ecoUrl: game.eco ?? headers.ECOUrl ?? null,
      openingName: openingNameFromEcoUrl(game.eco ?? headers.ECOUrl),
      termination: headers.Termination ?? null,
      plyCount: moves.length,
      deriveVersion: DERIVE_VERSION
    },
    pgn: game.pgn,
    plies: replayed.map((ply, index) => ({
      ply: index + 1,
      ...ply,
      clockMs: toMs(moves[index].clockSec),
      spentMs: toMs(spent[index])
    }))
  };
}

/**
 * Filters and derives one archive month. Every entry lands in exactly one bucket, so
 * games.length + sum(skipped) === rawGames.length. The 6-month window is NOT applied here;
 * it is a query filter.
 */
export function deriveMonth(owner: string, month: string, rawGames: unknown[]): DerivedMonth {
  const skipped = emptySkipCounts();
  const games: DerivedGame[] = [];
  const seen = new Set<string>();

  for (const entry of rawGames) {
    const parsed = rawGameSchema.safeParse(entry);
    if (!parsed.success) {
      skipped.malformed += 1;
      continue;
    }

    const game = parsed.data;
    const headers = parsePgnHeaders(game.pgn);
    const reason = skipReason(owner, game, headers);
    if (reason) {
      skipped[reason] += 1;
      continue;
    }

    const id = gameIdFromUrl(game.url);
    const keys = [`id:${id}`, ...(game.uuid ? [`uuid:${game.uuid}`] : [])];
    if (keys.some((key) => seen.has(key))) {
      skipped.duplicate += 1;
      continue;
    }

    try {
      games.push(deriveGame(owner, month, game, headers));
      keys.forEach((key) => seen.add(key));
    } catch {
      skipped.malformed += 1;
    }
  }

  return { games, skipped };
}

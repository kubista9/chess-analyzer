import { z } from "zod";
import { BULK_ANALYSIS_LIMITS, SUPPORTED_TIME_CLASSES } from "../../shared/constants.js";
import { familyFromOpening } from "../../shared/chess.js";
import type { ArchiveGame, PlayerColor, TimeClass } from "../../shared/types.js";
import { config } from "../config.js";
import { readJsonFile, safeKey, writeJsonFile } from "../store/fileStore.js";

const archiveListSchema = z.object({
  archives: z.array(z.string())
});

const gameSchema = z.object({
  url: z.string(),
  pgn: z.string(),
  time_class: z.string(),
  time_control: z.string().optional().default("?"),
  end_time: z.number(),
  rated: z.boolean().optional().default(false),
  eco: z.string().optional().nullable(),
  opening: z.string().optional().nullable(),
  white: z.object({
    username: z.string(),
    rating: z.number().or(z.string().transform((value) => Number(value))).optional().default(0),
    result: z.string()
  }),
  black: z.object({
    username: z.string(),
    rating: z.number().or(z.string().transform((value) => Number(value))).optional().default(0),
    result: z.string()
  })
});

const archiveResponseSchema = z.object({
  games: z.array(gameSchema)
});

interface RawGamesCache {
  createdAt: string;
  games: ArchiveGame[];
}

interface FetchRecentGamesOptions {
  refresh?: boolean;
  minimumStoredGames?: number;
}

export interface RecentGamesResult {
  games: ArchiveGame[];
  cache: {
    previousFetchedAt: string | null;
    fetchedAt: string;
    refreshed: boolean;
    newGames: number;
  };
}

const defaultStoredGameCount = BULK_ANALYSIS_LIMITS[BULK_ANALYSIS_LIMITS.length - 1];

function openingFromPgn(pgn: string): string | null {
  const match = pgn.match(/\[Opening "(.+)"\]/);
  return match?.[1] ?? null;
}

function openingFromEcoUrl(ecoUrl: string | null | undefined): string | null {
  if (!ecoUrl) {
    return null;
  }

  try {
    const pathname = new URL(ecoUrl).pathname;
    const slug = pathname.split("/").filter(Boolean).at(-1);
    if (!slug) {
      return null;
    }

    return decodeURIComponent(slug).replace(/-/g, " ");
  } catch {
    return null;
  }
}

function normalizeOpeningName(rawOpening: string | null | undefined, ecoUrl: string | null | undefined, pgn: string): string {
  return rawOpening ?? openingFromPgn(pgn) ?? openingFromEcoUrl(ecoUrl) ?? "Unknown opening";
}

function resolvePlayerColor(username: string, whiteUsername: string, blackUsername: string): PlayerColor | null {
  const needle = username.toLowerCase();

  if (whiteUsername.toLowerCase() === needle) {
    return "white";
  }

  if (blackUsername.toLowerCase() === needle) {
    return "black";
  }

  return null;
}

function toArchiveGame(username: string, rawGame: z.infer<typeof gameSchema>): ArchiveGame | null {
  if (!SUPPORTED_TIME_CLASSES.includes(rawGame.time_class as TimeClass)) {
    return null;
  }

  const playerColor = resolvePlayerColor(username, rawGame.white.username, rawGame.black.username);
  if (!playerColor) {
    return null;
  }

  const openingName = normalizeOpeningName(rawGame.opening, rawGame.eco, rawGame.pgn);
  const id = rawGame.url.split("/").filter(Boolean).at(-1) ?? `${rawGame.end_time}`;

  return {
    id,
    url: rawGame.url,
    pgn: rawGame.pgn,
    endTime: rawGame.end_time,
    timeClass: rawGame.time_class as TimeClass,
    timeControl: rawGame.time_control ?? "?",
    rated: rawGame.rated ?? false,
    openingName,
    openingUrl: rawGame.eco ?? null,
    openingFamily: familyFromOpening(openingName),
    white: {
      username: rawGame.white.username,
      rating: Number(rawGame.white.rating ?? 0),
      result: rawGame.white.result
    },
    black: {
      username: rawGame.black.username,
      rating: Number(rawGame.black.rating ?? 0),
      result: rawGame.black.result
    }
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": config.userAgent,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Chess.com request failed (${response.status}) for ${url}`);
  }

  return response.json();
}

function rawGamesCachePath(username: string): string {
  return `${config.cacheDir}/raw-games/${safeKey(username)}.json`;
}

function sortNewestFirst(games: ArchiveGame[]): ArchiveGame[] {
  return [...games].sort((left, right) => right.endTime - left.endTime);
}

function mergeGamesById(freshGames: ArchiveGame[], cachedGames: ArchiveGame[]): ArchiveGame[] {
  const merged = new Map<string, ArchiveGame>();

  for (const game of [...freshGames, ...cachedGames]) {
    if (!merged.has(game.id)) {
      merged.set(game.id, game);
    }
  }

  return sortNewestFirst([...merged.values()]);
}

export async function fetchRecentGamesWithCacheStatus(
  username: string,
  limit: number,
  options: FetchRecentGamesOptions = {}
): Promise<RecentGamesResult> {
  const normalized = username.trim().toLowerCase();
  const cachePath = rawGamesCachePath(normalized);
  const cached = await readJsonFile<RawGamesCache>(cachePath);
  const cachedGames = sortNewestFirst(cached?.games ?? []);
  const targetStoredGames = Math.max(limit, options.minimumStoredGames ?? defaultStoredGameCount);

  if (!options.refresh && cachedGames.length >= limit) {
    return {
      games: cachedGames.slice(0, limit),
      cache: {
        previousFetchedAt: cached?.createdAt ?? null,
        fetchedAt: cached?.createdAt ?? new Date().toISOString(),
        refreshed: false,
        newGames: 0
      }
    };
  }

  const archivesPayload = archiveListSchema.parse(
    await fetchJson(`https://api.chess.com/pub/player/${normalized}/games/archives`)
  );

  const collected: ArchiveGame[] = [];
  const cachedIds = new Set(cachedGames.map((game) => game.id));
  const latestCachedGameId = cachedGames[0]?.id ?? null;
  const archives = [...archivesPayload.archives].reverse();
  let reachedCachedBoundary = false;

  archiveLoop: for (const archiveUrl of archives) {
    const archivePayload = archiveResponseSchema.parse(await fetchJson(archiveUrl));

    for (const rawGame of [...archivePayload.games].reverse()) {
      const parsed = toArchiveGame(normalized, rawGame);
      if (!parsed) {
        continue;
      }

      if (parsed.id === latestCachedGameId) {
        reachedCachedBoundary = true;
      }

      if (!cachedIds.has(parsed.id)) {
        collected.push(parsed);
      }

      const mergedGameCount = collected.length + cachedGames.length;
      if (mergedGameCount >= targetStoredGames && (!latestCachedGameId || reachedCachedBoundary)) {
        break archiveLoop;
      }

      if (!reachedCachedBoundary && collected.length >= targetStoredGames) {
        break archiveLoop;
      }
    }
  }

  const fetchedAt = new Date().toISOString();
  const games = mergeGamesById(collected, cachedGames);
  await writeJsonFile(cachePath, {
    createdAt: fetchedAt,
    games
  });

  return {
    games: games.slice(0, limit),
    cache: {
      previousFetchedAt: cached?.createdAt ?? null,
      fetchedAt,
      refreshed: true,
      newGames: collected.length
    }
  };
}

export async function fetchRecentGames(username: string, limit: number): Promise<ArchiveGame[]> {
  const result = await fetchRecentGamesWithCacheStatus(username, limit);
  return result.games;
}

export async function findGameForUser(username: string, gameId: string): Promise<ArchiveGame | null> {
  const cachePath = rawGamesCachePath(username);
  const cached = await readJsonFile<{ createdAt: string; games: ArchiveGame[] }>(cachePath);
  const cachedGame = cached?.games.find((game) => game.id === gameId) ?? null;

  if (cachedGame) {
    return cachedGame;
  }

  const freshGames = await fetchRecentGames(username, defaultStoredGameCount);
  return freshGames.find((game) => game.id === gameId) ?? null;
}

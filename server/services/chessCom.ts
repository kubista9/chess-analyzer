import { z } from "zod";
import { SUPPORTED_TIME_CLASSES } from "../../shared/constants.js";
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

export async function fetchRecentGames(username: string, limit: number): Promise<ArchiveGame[]> {
  const normalized = username.trim().toLowerCase();
  const cachePath = rawGamesCachePath(normalized);
  const cached = await readJsonFile<{ createdAt: string; games: ArchiveGame[] }>(cachePath);
  if (cached?.games.length && cached.games.length >= limit) {
    return cached.games.slice(0, limit);
  }

  const archivesPayload = archiveListSchema.parse(
    await fetchJson(`https://api.chess.com/pub/player/${normalized}/games/archives`)
  );

  const collected: ArchiveGame[] = [];
  const archives = [...archivesPayload.archives].reverse();

  for (const archiveUrl of archives) {
    const archivePayload = archiveResponseSchema.parse(await fetchJson(archiveUrl));

    for (const rawGame of [...archivePayload.games].reverse()) {
      const parsed = toArchiveGame(normalized, rawGame);
      if (!parsed) {
        continue;
      }

      collected.push(parsed);
      if (collected.length >= Math.max(limit, 150)) {
        break;
      }
    }

    if (collected.length >= Math.max(limit, 150)) {
      break;
    }
  }

  await writeJsonFile(cachePath, {
    createdAt: new Date().toISOString(),
    games: collected
  });

  return collected.slice(0, limit);
}

export async function findGameForUser(username: string, gameId: string): Promise<ArchiveGame | null> {
  const cachePath = rawGamesCachePath(username);
  const cached = await readJsonFile<{ createdAt: string; games: ArchiveGame[] }>(cachePath);
  const cachedGame = cached?.games.find((game) => game.id === gameId) ?? null;

  if (cachedGame) {
    return cachedGame;
  }

  const freshGames = await fetchRecentGames(username, 150);
  return freshGames.find((game) => game.id === gameId) ?? null;
}

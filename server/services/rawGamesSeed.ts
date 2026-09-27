import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { listMonthMeta } from "../db/archiveMonths.js";
import type { Db } from "../db/connection.js";
import { monthsWithGames, replaceMonthGames } from "../db/games.js";
import { safeKey } from "../store/fileStore.js";
import { deriveMonth, utcMonth } from "./gameDerive.js";

// Offline fallback: the legacy storage/cache/raw-games/<owner>.json (converted game
// objects, read-only, never deleted) can fill months that have no archive data yet. Seeded
// rows are marked source = 'raw-games-seed' and are replaced by the real month on the next
// online sync.

export function rawGamesCachePath(owner: string, cacheDir = config.cacheDir): string {
  return path.join(cacheDir, "raw-games", `${safeKey(owner)}.json`);
}

/** The fields the seed reads from a game in the legacy raw-games/<owner>.json (read-only here). */
export interface LegacyRawGame {
  id: string;
  url: string;
  pgn: string;
  endTime: number;
  timeClass: string;
  timeControl: string;
  rated: boolean;
  openingName: string;
  openingUrl: string | null;
  white: { username: string; rating: number; result: string };
  black: { username: string; rating: number; result: string };
}

/** A legacy raw-games entry in the raw archive shape that deriveMonth expects. */
function toRawShape(game: LegacyRawGame): Record<string, unknown> {
  const variant = /^\s*\[Variant\s+"([^"]*)"\]/m.exec(game.pgn)?.[1];
  return {
    url: game.url,
    pgn: game.pgn,
    end_time: game.endTime,
    time_class: game.timeClass,
    time_control: game.timeControl,
    rated: game.rated,
    rules: variant && variant !== "Standard" ? variant.toLowerCase() : "chess",
    eco: game.openingUrl,
    white: game.white,
    black: game.black
  };
}

/** Seeds every month that has neither an archive row nor games. Returns the seeded months. */
export function seedFromRawGamesCache(db: Db, owner: string, filePath: string = rawGamesCachePath(owner)): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const payload = JSON.parse(fs.readFileSync(filePath, "utf8")) as { games?: LegacyRawGame[] };
  const archived = new Set(listMonthMeta(db, owner).map((row) => row.month));
  const filled = monthsWithGames(db, owner);
  const byMonth = new Map<string, Record<string, unknown>[]>();

  for (const game of payload.games ?? []) {
    const month = utcMonth(game.endTime);
    if (!archived.has(month) && !filled.has(month)) {
      byMonth.set(month, [...(byMonth.get(month) ?? []), toRawShape(game)]);
    }
  }

  const seeded = [...byMonth.keys()].sort();
  for (const month of seeded) {
    replaceMonthGames(db, owner, month, deriveMonth(owner, month, byMonth.get(month) ?? []).games, "raw-games-seed");
  }
  return seeded;
}

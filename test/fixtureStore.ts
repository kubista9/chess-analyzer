import { openDatabase, type Db } from "../server/db/connection.js";
import { replaceMonthGames } from "../server/db/games.js";
import { deriveMonth, utcMonth } from "../server/services/gameDerive.js";
import { loadOwnerGames } from "./loadFixtures.js";

export const FIXTURE_OWNER = "kubista9";

/** An in-memory store holding the owner's 8 real fixture games (2026-04-22 .. 2026-09-26). */
export function fixtureStore(): Db {
  const db = openDatabase(":memory:");
  const byMonth = new Map<string, unknown[]>();
  for (const game of loadOwnerGames()) {
    const month = utcMonth(game.end_time);
    byMonth.set(month, [...(byMonth.get(month) ?? []), game]);
  }
  for (const [month, games] of byMonth) {
    replaceMonthGames(db, FIXTURE_OWNER, month, deriveMonth(FIXTURE_OWNER, month, games).games, "archive");
  }
  return db;
}

import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import type { OpeningBook } from "../../shared/openingBook.js";
import { buildTree, preGameRatings, treeGameFrom, type OpeningTree, type TreeGame } from "../../shared/openingTree.js";
import type { PlayerColor, QueryWindow, TimeClass } from "../../shared/types.js";
import { GAME_WINDOWS, windowBounds, type GameWindow, type WindowBounds } from "../../shared/window.js";
import type { Db } from "../db/connection.js";
import { gamesStamp, listGames, listOpeningPlies, listRatingHistory } from "../db/games.js";

/**
 * Default recency half-life per window (critic correction to P3): 90 days on the 6-month view,
 * and no weighting on the 3-month view, where a 60-day half-life inside a 90-day window
 * would discount twice. `?hl=` overrides it (60 reproduces GLOBAL's H = 60).
 */
export const DEFAULT_HALF_LIFE_BY_WINDOW: Record<GameWindow, number | null> = { "6m": 90, "3m": null };

/** A memoised tree is rebuilt after this long even if no game changed, so the window keeps moving. */
export const TREE_MAX_AGE_MS = 10 * 60 * 1000;
const MEMO_SIZE = 16;

export interface TreeFilters {
  color: PlayerColor;
  window: GameWindow;
  timeClass: TimeClass | null;
  halfLifeDays: number | null;
}

export type RatingMode = "pre-game" | "post-game";

/**
 * The owner's games of one colour in `bounds` as TreeGames, from the store (no replay).
 * "pre-game" rates the owner by his previous post-game rating in the same time class (the
 * critic's correction); "post-game" uses Chess.com's reported rating, as the plan's goldens did.
 */
export function loadTreeGames(
  db: Db,
  owner: string,
  bounds: WindowBounds,
  filter: { color: PlayerColor; timeClass: TimeClass | null },
  ratings: RatingMode = "pre-game",
  maxPly: number = OPENING_PLY_LIMIT
): TreeGame[] {
  const gameFilter = { color: filter.color, timeClass: filter.timeClass ?? undefined };
  const records = listGames(db, owner, bounds, gameFilter);
  const plies = listOpeningPlies(db, owner, bounds, gameFilter, maxPly);
  const pre = ratings === "pre-game" ? preGameRatings(listRatingHistory(db, owner)) : undefined;
  return records.map((record) => treeGameFrom(record, plies.get(record.id) ?? [], pre?.get(record.id) ?? record.myRating));
}

export interface BuiltTree {
  window: QueryWindow;
  filters: TreeFilters;
  tree: OpeningTree;
  buildMs: number;
}

interface MemoEntry extends BuiltTree {
  stamp: string;
  builtAt: number;
}

export interface TreeServiceDeps {
  db: () => Db;
  owner: string;
  book: () => OpeningBook;
}

/**
 * Builds opening trees over the store and memoises them by filters. An entry is reused until
 * the stored games change (gamesStamp, so a server or CLI sync invalidates it) or it is older
 * than TREE_MAX_AGE_MS.
 */
export function createTreeService(deps: TreeServiceDeps) {
  const memo = new Map<string, MemoEntry>();

  function getTree(filters: TreeFilters, nowMs: number): BuiltTree {
    const db = deps.db();
    const key = `${filters.color}|${filters.window}|${filters.timeClass ?? "all"}|${filters.halfLifeDays ?? "off"}`;
    const stamp = gamesStamp(db, deps.owner);
    const hit = memo.get(key);
    if (hit && hit.stamp === stamp && nowMs - hit.builtAt < TREE_MAX_AGE_MS) {
      // Most recently used last.
      memo.delete(key);
      memo.set(key, hit);
      return hit;
    }

    const started = performance.now();
    const days = GAME_WINDOWS[filters.window];
    const now = Math.floor(nowMs / 1000);
    const window: QueryWindow = { key: filters.window, days, ...windowBounds(now, days) };
    const games = loadTreeGames(db, deps.owner, window, filters);
    const tree = buildTree(games, { color: filters.color, now, halfLifeDays: filters.halfLifeDays, book: deps.book() });
    const entry: MemoEntry = { window, filters, tree, buildMs: performance.now() - started, stamp, builtAt: nowMs };

    memo.delete(key);
    memo.set(key, entry);
    while (memo.size > MEMO_SIZE) {
      memo.delete(memo.keys().next().value!);
    }
    return entry;
  }

  return { getTree, clear: () => memo.clear() };
}

export type TreeService = ReturnType<typeof createTreeService>;

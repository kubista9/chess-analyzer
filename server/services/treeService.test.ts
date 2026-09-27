import { describe, expect, it } from "vitest";
import { START_EPD } from "../../shared/epd.js";
import { buildBook } from "../../shared/openingBook.js";
import { gameId, loadOwnerGames } from "../../test/loadFixtures.js";
import { openDatabase, type Db } from "../db/connection.js";
import { replaceMonthGames } from "../db/games.js";
import { finishSyncRun, startSyncRun } from "../db/syncRuns.js";
import { deriveMonth, utcMonth } from "./gameDerive.js";
import { TREE_MAX_AGE_MS, createTreeService, loadTreeGames, type TreeFilters } from "./treeService.js";

const OWNER = "kubista9";
const NOW_MS = Date.parse("2026-09-27T00:00:00Z");
const emptyBook = buildBook([]);

function store(skip: string[] = []): Db {
  const db = openDatabase(":memory:");
  const byMonth = new Map<string, unknown[]>();
  for (const game of loadOwnerGames().filter((raw) => !skip.includes(gameId(raw)))) {
    const month = utcMonth(game.end_time);
    byMonth.set(month, [...(byMonth.get(month) ?? []), game]);
  }
  for (const [month, games] of byMonth) {
    replaceMonthGames(db, OWNER, month, deriveMonth(OWNER, month, games).games, "archive");
  }
  return db;
}

const white: TreeFilters = { color: "white", window: "6m", timeClass: null, halfLifeDays: 90 };

describe("loadTreeGames", () => {
  it("loads one colour's games with their first 20 plies from the store", () => {
    const db = store();
    const bounds = { start: NOW_MS / 1000 - 183 * 86_400, end: NOW_MS / 1000 };
    const games = loadTreeGames(db, OWNER, bounds, { color: "black", timeClass: null });
    expect(games.map((game) => game.id)).toEqual(["184405952510", "184397818138", "170180310304", "167672140552"]);
    expect(games.every((game) => game.plies.length === 20 && game.baseMs === 180_000)).toBe(true);
    expect(games[0].plies[0]).toMatchObject({ san: "e4", uci: "e2e4", epdBefore: START_EPD });
  });

  it("rates the owner by his previous blitz game's post-game rating", () => {
    const db = store();
    const bounds = { start: 0, end: NOW_MS / 1000 };
    const pre = new Map(loadTreeGames(db, OWNER, bounds, { color: "black", timeClass: null }).map((game) => [game.id, game.myRating]));
    const post = new Map(
      loadTreeGames(db, OWNER, bounds, { color: "black", timeClass: null }, "post-game").map((game) => [game.id, game.myRating])
    );
    // 184405952510 follows 184397818138 (post-game 1220); the first stored game keeps its own.
    expect(pre.get("184405952510")).toBe(1220);
    expect(post.get("184405952510")).toBe(1221);
    expect(pre.get("167672140552")).toBe(post.get("167672140552"));
  });
});

describe("createTreeService", () => {
  it("memoises by filters and rebuilds after the stored games change", () => {
    const db = store(["184405952510"]);
    const service = createTreeService({ db: () => db, owner: OWNER, book: () => emptyBook });
    const first = service.getTree(white, NOW_MS);
    expect(service.getTree(white, NOW_MS + 1000).tree).toBe(first.tree);
    expect(service.getTree({ ...white, halfLifeDays: null }, NOW_MS).tree).not.toBe(first.tree);

    const black = service.getTree({ ...white, color: "black" }, NOW_MS);
    expect(black.tree.games).toBe(3);

    // A sync stores the missing game: the next request sees it.
    const raw = loadOwnerGames().find((game) => gameId(game) === "184405952510")!;
    const month = utcMonth(raw.end_time);
    const september = loadOwnerGames().filter((game) => utcMonth(game.end_time) === month);
    replaceMonthGames(db, OWNER, month, deriveMonth(OWNER, month, september).games, "archive");
    expect(service.getTree({ ...white, color: "black" }, NOW_MS).tree.games).toBe(4);
  });

  it("rebuilds after a finished sync run and after the maximum age", () => {
    const db = store();
    const service = createTreeService({ db: () => db, owner: OWNER, book: () => emptyBook });
    const first = service.getTree(white, NOW_MS);
    finishSyncRun(db, startSyncRun(db, OWNER, NOW_MS), NOW_MS, true, {});
    const afterSync = service.getTree(white, NOW_MS);
    expect(afterSync.tree).not.toBe(first.tree);
    expect(service.getTree(white, NOW_MS + TREE_MAX_AGE_MS + 1).tree).not.toBe(afterSync.tree);
  });

  it("builds the window from now and reports it", () => {
    const db = store();
    const service = createTreeService({ db: () => db, owner: OWNER, book: () => emptyBook });
    const built = service.getTree({ ...white, window: "3m", halfLifeDays: null }, NOW_MS);
    expect(built.window).toEqual({ key: "3m", days: 90, start: NOW_MS / 1000 - 90 * 86_400, end: NOW_MS / 1000 });
    expect(built.tree.games).toBe(3);
    expect(built.tree.nodes.get(START_EPD)!.n).toBe(3);
  });
});

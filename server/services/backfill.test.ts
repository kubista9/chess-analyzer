import { afterEach, describe, expect, it } from "vitest";
import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import type { BackfillProgress, GameOpeningSummary } from "../../shared/types.js";
import { legalFakePool } from "../../test/fakeEngine.js";
import { FIXTURE_OWNER, fixtureStore } from "../../test/fixtureStore.js";
import { lastBackfillRun } from "../db/backfillRuns.js";
import type { Db } from "../db/connection.js";
import { countAnalysisQueue, getGameAnalysis, listAnalysisQueue } from "../db/gameAnalysis.js";
import { listOpeningMoves } from "../db/games.js";
import { countPositions, getPositionEval } from "../db/positions.js";
import { currentEngineConfig } from "../engine/engineConfig.js";
import type { EnginePool } from "../engine/pool.js";
import { planBackfill, runBackfill } from "./backfill.js";
import { isAnswered, openingPositions, positionKey } from "./openingPass.js";

const pools: EnginePool[] = [];
const dbs: Db[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  dbs.splice(0).forEach((db) => db.close());
});

function setup(options: Parameters<typeof legalFakePool>[0] = {}) {
  const db = fixtureStore();
  dbs.push(db);
  const fake = legalFakePool(options);
  pools.push(fake.pool);
  const run = (extra: Parameters<typeof runBackfill>[1] = {}) =>
    runBackfill({ db, pool: fake.pool, owner: FIXTURE_OWNER, source: "cli" }, { windowStart: 0, ...extra });
  return { db, ...fake, run };
}

/** Every (tier, EPD) of the fixture games and the moves played from it. */
function windowPositions(db: Db) {
  const played = new Map<string, Set<string>>();
  for (const game of listOpeningMoves(db, FIXTURE_OWNER, 0, OPENING_PLY_LIMIT).values()) {
    for (const position of openingPositions(game.plies, game.color)) {
      const key = positionKey(position);
      played.set(key, (played.get(key) ?? new Set()).add(position.played));
    }
  }
  return played;
}

/**
 * Positions searched from scratch: an EPD reached in both roles (the start position here) is
 * searched once, at the owner tier, whose row also answers the opponent-tier request.
 */
function searchedPositions(db: Db): number {
  const keys = [...windowPositions(db).keys()];
  const ownerEpds = new Set(keys.filter((key) => key.startsWith("owner|")).map((key) => key.slice(6)));
  return keys.filter((key) => !(key.startsWith("opponent|") && ownerEpds.has(key.slice(9)))).length;
}

describe("planBackfill", () => {
  it("covers each (tier, EPD) once, newest game first, with every move played from it merged", () => {
    const { db } = setup();
    const config = currentEngineConfig(db, "Stockfish 18");
    const plan = planBackfill(db, { owner: FIXTURE_OWNER, configId: config.id, windowStart: 0 });
    const expected = windowPositions(db);

    expect(plan.games.map((game) => game.id)).toEqual(listAnalysisQueue(db, { username: FIXTURE_OWNER, configId: config.id, windowStart: 0, openingPlies: 20 }).map((game) => game.id));
    const items = [...plan.passes.owner, ...plan.passes.opponent].flatMap((group) => group.items);
    expect(items.map((item) => item.key).sort()).toEqual([...expected.keys()].sort());
    for (const item of items) {
      expect(new Set(item.played)).toEqual(expected.get(item.key));
    }
    expect(plan.positions).toMatchObject({ total: expected.size, cached: 0, partial: 0 });
    expect(plan.positions.toSearch.owner + plan.positions.toSearch.opponent).toBe(expected.size);
    // The start position is owner to move in the White games and opponent to move in the Black ones.
    expect(items.filter((item) => item.position.ply === 1).map((item) => item.position.tier).sort()).toEqual(["opponent", "owner"]);
    expect(planBackfill(db, { owner: FIXTURE_OWNER, configId: config.id, windowStart: 0, limit: 2 }).games).toHaveLength(2);
  });
});

describe("runBackfill", () => {
  it("analyses every queued game, owner positions first, and a second run analyses none (incremental rule)", async () => {
    const { db, log, run } = setup();
    const progress: BackfillProgress[] = [];
    const first = await run({ onProgress: (update) => progress.push(update) });
    const config = currentEngineConfig(db, "Stockfish 18");
    const unique = searchedPositions(db);
    expect(unique).toBe(windowPositions(db).size - 1);

    expect(first).toMatchObject({ status: "completed", gamesAnalysed: 8, gamesFailed: 0, errors: [] });
    expect(countAnalysisQueue(db, { username: FIXTURE_OWNER, configId: config.id, windowStart: 0, openingPlies: 20 })).toBe(0);
    expect(countPositions(db, config.id).owner + countPositions(db, config.id).opponent).toBe(unique);
    // Each position's main search once, plus its follow-up when a played move is outside its lines.
    const mains = log.filter((search) => !search.searchmoves);
    expect(mains).toHaveLength(unique);
    // Pass A (MultiPV 3, the owner's positions) completes before pass B (MultiPV 1).
    const lastOwner = mains.map((search) => search.multipv).lastIndexOf(3);
    const firstOpponent = mains.map((search) => search.multipv).indexOf(1);
    expect(lastOwner).toBeLessThan(firstOpponent);

    for (const game of listOpeningMoves(db, FIXTURE_OWNER, 0, OPENING_PLY_LIMIT)) {
      const [id, moves] = game;
      const row = getGameAnalysis(db, id, config.id);
      const summary = row?.summary as GameOpeningSummary;
      expect(row?.plies).toBe(Math.min(OPENING_PLY_LIMIT, moves.plies.length));
      expect(summary.color).toBe(moves.color);
      expect(summary.owner.moves + summary.opponent.moves).toBe(row?.plies);
      for (const position of openingPositions(moves.plies, moves.color)) {
        expect(isAnswered(getPositionEval(db, config.id, position.epd, position.tier), [position.played])).toBe(true);
      }
    }

    const final = progress[progress.length - 1];
    expect(final).toMatchObject({ pass: "done", games: { total: 8, done: 8, failed: 0 } });
    expect(final.positions.owner.done).toBe(final.positions.owner.total);
    expect(final.positions.opponent.done).toBe(final.positions.opponent.total);
    expect(lastBackfillRun(db)).toMatchObject({ status: "completed", gamesDone: 8, positionsSearched: windowPositions(db).size, source: "cli" });

    const searches = log.length;
    const second = await run();
    expect(second).toMatchObject({ status: "completed", gamesAnalysed: 0, positionsSearched: 0 });
    expect(second.progress.games.total).toBe(0);
    expect(log).toHaveLength(searches);
  });

  it("redoes an interrupted game from the cache without searching again", async () => {
    const { db, log, run } = setup();
    await run();
    const config = currentEngineConfig(db, "Stockfish 18");
    const [victim] = listAnalysisQueue(db, { username: FIXTURE_OWNER, configId: -1, windowStart: 0, openingPlies: 20 });
    db.prepare("DELETE FROM game_analysis WHERE game_id = ?").run(victim.id);

    const searches = log.length;
    const again = await run();
    expect(again).toMatchObject({ status: "completed", gamesAnalysed: 1, positionsSearched: 0 });
    expect(again.progress.positions).toMatchObject({ owner: { total: 0 }, opponent: { total: 0 } });
    expect(log).toHaveLength(searches);
    expect(getGameAnalysis(db, victim.id, config.id)).toBeDefined();
  });

  it("pauses between games and resumes where it stopped, never searching a stored position twice", async () => {
    const { db, log, run } = setup({ size: 1 });
    const controller = new AbortController();
    const paused = await run({
      signal: controller.signal,
      onProgress: (update) => {
        if (update.positions.owner.done >= 3) {
          controller.abort();
        }
      }
    });
    expect(paused.status).toBe("paused");
    expect(paused.progress.pass).toBe("owner");
    // Pass B never started, so no game is complete yet; all of them stay queued.
    expect(paused.gamesAnalysed).toBe(0);
    const config = currentEngineConfig(db, "Stockfish 18");
    expect(countAnalysisQueue(db, { username: FIXTURE_OWNER, configId: config.id, windowStart: 0, openingPlies: 20 })).toBe(8);
    const stored = countPositions(db, config.id);
    expect(stored.owner).toBeGreaterThan(0);

    const resumed = await run();
    expect(resumed).toMatchObject({ status: "completed", gamesAnalysed: 8 });
    expect(resumed.progress.positions.cached).toBe(stored.owner + stored.opponent);
    expect(log.filter((search) => !search.searchmoves)).toHaveLength(searchedPositions(db));
    expect(lastBackfillRun(db)?.status).toBe("completed");
  });

  it("takes the newest games first with a limit", async () => {
    const { db, run } = setup();
    const result = await run({ limit: 3 });
    const config = currentEngineConfig(db, "Stockfish 18");
    expect(result.gamesAnalysed).toBe(3);
    const all = listAnalysisQueue(db, { username: FIXTURE_OWNER, configId: -1, windowStart: 0, openingPlies: 20 });
    expect(all.slice(0, 3).every((game) => getGameAnalysis(db, game.id, config.id))).toBe(true);
    expect(all.slice(3).some((game) => getGameAnalysis(db, game.id, config.id))).toBe(false);
  });

  it("re-queues every game under a new engine version and keeps the old rows", async () => {
    const { db, run } = setup();
    await run();
    const sf19 = legalFakePool({ idName: "Stockfish 19" });
    pools.push(sf19.pool);
    const query = { username: FIXTURE_OWNER, windowStart: 0, openingPlies: 20 };
    const newConfig = currentEngineConfig(db, "Stockfish 19");
    expect(countAnalysisQueue(db, { ...query, configId: newConfig.id })).toBe(8);
    const result = await runBackfill({ db, pool: sf19.pool, owner: FIXTURE_OWNER, source: "server" }, { windowStart: 0, limit: 1 });
    expect(result).toMatchObject({ configId: newConfig.id, gamesAnalysed: 1 });
    expect(sf19.log.filter((search) => !search.searchmoves).length).toBeGreaterThan(0);
    expect(countAnalysisQueue(db, { ...query, configId: currentEngineConfig(db, "Stockfish 18").id })).toBe(0);
  });

  it("fails only the games whose positions failed, and keeps them queued", async () => {
    // The engine dies on every search of one position (the retry dies too).
    const { db, run } = setup({ size: 1, crash: (request) => request.moves.join(" ") === "e2e4 e7e5 g1f3" });
    const result = await run();
    const config = currentEngineConfig(db, "Stockfish 18");
    expect(result.status).toBe("failed");
    expect(result.gamesFailed).toBeGreaterThan(0);
    expect(result.gamesAnalysed + result.gamesFailed).toBe(8);
    expect(result.errors[0]).toMatch(/exited unexpectedly/);
    expect(countAnalysisQueue(db, { username: FIXTURE_OWNER, configId: config.id, windowStart: 0, openingPlies: 20 })).toBe(result.gamesFailed);
  });
});

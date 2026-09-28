import { afterEach, describe, expect, it } from "vitest";
import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import { legalFakePool } from "../../test/fakeEngine.js";
import { FIXTURE_OWNER, fixtureStore } from "../../test/fixtureStore.js";
import type { Db } from "../db/connection.js";
import { countAnalysisQueue } from "../db/gameAnalysis.js";
import { listOpeningMoves } from "../db/games.js";
import { getPositionEval } from "../db/positions.js";
import { currentEngineConfig } from "../engine/engineConfig.js";
import type { EnginePool } from "../engine/pool.js";
import { analyseLine } from "./lineAnalysis.js";
import { isAnswered } from "./openingPass.js";

const pools: EnginePool[] = [];
const dbs: Db[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  dbs.splice(0).forEach((db) => db.close());
});

describe("analyseLine", () => {
  it("analyses every position of a line with the moves the games played there, then answers it from the cache", async () => {
    const db = fixtureStore();
    dbs.push(db);
    const fake = legalFakePool();
    pools.push(fake.pool);
    const configId = currentEngineConfig(db, await fake.pool.engineIdName()).id;
    // A fixture game's first three moves, as its owner colour.
    const [game] = [...listOpeningMoves(db, FIXTURE_OWNER, 0, OPENING_PLY_LIMIT).values()];
    const moves = game.plies.slice(0, 3).map((ply) => ply.uci);
    const query = { owner: FIXTURE_OWNER, color: game.color, moves, windowStart: 0 };

    const first = await analyseLine({ db, pool: fake.pool, configId }, query);
    expect(first.positions).toHaveLength(4);
    expect(first.searched).toBe(4);
    for (const [index, { position }] of first.positions.entries()) {
      expect(position.tier).toBe((index % 2 === 0 ? "white" : "black") === game.color ? "owner" : "opponent");
      const stored = getPositionEval(db, configId, position.epd, position.tier);
      expect(isAnswered(stored, index < 3 ? [moves[index]] : [])).toBe(true);
    }
    // Nothing is marked analysed: the backfill still queues every game.
    expect(countAnalysisQueue(db, { username: FIXTURE_OWNER, configId, windowStart: 0, openingPlies: OPENING_PLY_LIMIT })).toBe(8);

    const searches = fake.log.length;
    const again = await analyseLine({ db, pool: fake.pool, configId }, query);
    expect(again.searched).toBe(0);
    expect(fake.log).toHaveLength(searches);
  });
});

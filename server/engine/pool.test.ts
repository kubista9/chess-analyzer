import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scoreWinPercent } from "../../shared/eval.js";
import type { EngineLine } from "../../shared/types.js";
import type { PositionRequest } from "./analysePosition.js";
import { EnginePool, EnginePoolClosedError, type PoolEngine } from "./pool.js";
import { EngineCrashedError, UciEngine, type SearchRequest, type SearchResult } from "./uci.js";

const GAME = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6"];

/** One request per position of a game: the positions before moves from..n-1. */
function gameRequests(moves: string[], n = moves.length, from = 0): PositionRequest[] {
  return Array.from({ length: n - from }, (_, index) => ({ moves: moves.slice(0, from + index), tier: "opponent" as const }));
}

function line(uci: string): EngineLine {
  return { uci, cp: 10, mate: null, winPct: scoreWinPercent({ cp: 10, mate: null }), depth: 14, pv: [uci] };
}

interface SearchLog {
  engine: number;
  plies: number;
}

/** An in-memory engine. `crash(request)` makes a search die like a killed process. */
class FakeEngine implements PoolEngine {
  alive = true;
  idName = "Stockfish 18";
  newGames = 0;
  closed = false;

  constructor(
    readonly index: number,
    private readonly log: SearchLog[],
    private readonly delayMs: number,
    private readonly crash: (request: SearchRequest, engine: FakeEngine) => boolean
  ) {}

  async newGame(): Promise<void> {
    this.newGames += 1;
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    if (!this.alive) {
      throw new EngineCrashedError("dead");
    }
    this.log.push({ engine: this.index, plies: request.moves.length });
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.crash(request, this)) {
      this.alive = false;
      throw new EngineCrashedError("Engine exited unexpectedly (signal SIGKILL)");
    }
    const lines = (request.searchmoves ?? ["a2a3"]).map(line);
    return { lines, depth: 14, complete: true, nodes: 1000, bestmove: lines[0].uci, ms: this.delayMs };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.alive = false;
  }

  kill(): void {
    this.alive = false;
  }
}

function fakePool(size: number, options: { delayMs?: number; crash?: (request: SearchRequest, engine: FakeEngine) => boolean } = {}) {
  const log: SearchLog[] = [];
  const engines: FakeEngine[] = [];
  const pool = new EnginePool({
    size,
    spawn: async () => {
      const engine = new FakeEngine(engines.length, log, options.delayMs ?? 5, options.crash ?? (() => false));
      engines.push(engine);
      return engine;
    }
  });
  pools.push(pool);
  return { pool, log, engines };
}

const pools: EnginePool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

describe("EnginePool", () => {
  it("runs a game's positions in order on one engine with one ucinewgame", async () => {
    const { pool, log, engines } = fakePool(1);
    const progress: number[] = [];
    const results = await pool.analyseGame("g1", gameRequests(GAME), {
      priority: "backfill",
      onProgress: (done) => progress.push(done)
    });
    expect(results).toHaveLength(GAME.length);
    expect(log.map((entry) => entry.plies)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(engines).toHaveLength(1);
    expect(engines[0].newGames).toBe(1);
    expect(progress).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("lets interactive work jump ahead between positions of a backfill game", async () => {
    const { pool, log, engines } = fakePool(1, { delayMs: 10 });
    const backfill = pool.analyseGame("backfill-game", gameRequests(GAME, 5), { priority: "backfill" });
    const queuedBackfill = pool.analyseGame("backfill-game-2", gameRequests(["d2d4", "d7d5", "c2c4", "e7e5"], 4, 1), {
      priority: "backfill"
    });
    // Submit the interactive game while the first backfill position is running.
    await new Promise((resolve) => setTimeout(resolve, 3));
    const interactive = pool.analyseGame("review", gameRequests(["c2c4", "e7e5", "b1c3"], 3, 1), { priority: "interactive" });

    await Promise.all([backfill, queuedBackfill, interactive]);
    // The first backfill position finishes, then the review's positions, then the rest of the
    // first backfill game (handed back to the front of its queue), then the second game.
    expect(log.map((entry) => entry.plies)).toEqual([0, 1, 2, 1, 2, 3, 4, 1, 2, 3]);
    expect(pool.stats()).toMatchObject({ queued: { interactive: 0, backfill: 0 } });
    // ucinewgame per game switch (backfill, review, backfill again, game 2), never per position.
    expect(engines[0].newGames).toBe(4);
  });

  it("puts interactive games ahead of queued backfill games", async () => {
    const { pool, log } = fakePool(1, { delayMs: 5 });
    const done: string[] = [];
    const a = pool.analyseGame("a", gameRequests(GAME, 2), { priority: "backfill" }).then(() => done.push("a"));
    const b = pool.analyseGame("b", gameRequests(GAME, 2), { priority: "backfill" }).then(() => done.push("b"));
    const c = pool.analyseGame("c", gameRequests(["d2d4"], 1), { priority: "interactive" }).then(() => done.push("c"));
    await Promise.all([a, b, c]);
    expect(done).toEqual(["c", "a", "b"]);
    expect(log[0].plies).toBe(0);
  });

  it("spreads games over the workers, each game on one engine", async () => {
    const { pool, log, engines } = fakePool(3, { delayMs: 5 });
    await Promise.all(
      [["e2e4", "e7e5", "g1f3"], ["d2d4", "d7d5", "c2c4"], ["c2c4", "e7e5", "b1c3"]].map((moves, index) =>
        pool.analyseGame(`g${index}`, gameRequests(moves, 3, 1), { priority: "backfill" })
      )
    );
    expect(engines).toHaveLength(3);
    for (const engine of engines) {
      expect(log.filter((entry) => entry.engine === engine.index)).toHaveLength(2);
      expect(engine.newGames).toBe(1);
    }
  });

  it("shares the start position between games queued together", async () => {
    const { pool, log } = fakePool(1);
    await Promise.all([
      pool.analyseGame("a", gameRequests(["e2e4", "e7e5"]), { priority: "backfill" }),
      pool.analyseGame("b", gameRequests(["d2d4", "d7d5"]), { priority: "backfill" })
    ]);
    expect(log.map((entry) => entry.plies)).toEqual([0, 1, 1]);
  });

  it("shares one search between identical requests in flight", async () => {
    const { pool, log } = fakePool(2, { delayMs: 10 });
    const request: PositionRequest = { moves: ["e2e4"], tier: "owner", played: ["e7e5"] };
    const [first, second] = await Promise.all([pool.analyse(request, "backfill"), pool.analyse(request, "backfill")]);
    expect(first).toBe(second);
    // One main search plus one searchmoves follow-up, not two of each.
    expect(log).toHaveLength(2);
    // An interactive request does not wait behind a queued backfill twin.
    await Promise.all([pool.analyse(request, "backfill"), pool.analyse(request, "interactive")]);
    expect(log).toHaveLength(6);
  });

  it("respawns a crashed engine and retries the position once", async () => {
    let crashes = 0;
    const { pool, engines } = fakePool(1, {
      crash: (request) => request.moves.length === 2 && crashes++ === 0
    });
    const results = await pool.analyseGame("g", gameRequests(GAME, 4), { priority: "interactive" });
    expect(results).toHaveLength(4);
    expect(engines).toHaveLength(2);
    // The new engine starts with ucinewgame.
    expect(engines[1].newGames).toBe(1);
  });

  it("fails the game after a second crash, drops its remaining positions, and keeps serving others", async () => {
    const { pool, log, engines } = fakePool(1, { crash: (request) => request.moves.length === 2 });
    await expect(pool.analyseGame("g", gameRequests(GAME, 6), { priority: "interactive" })).rejects.toThrow(EngineCrashedError);
    expect(log.map((entry) => entry.plies)).toEqual([0, 1, 2, 2]);
    expect(engines).toHaveLength(2);
    expect(pool.stats().queued).toEqual({ interactive: 0, backfill: 0 });
    await expect(pool.analyseGame("next", gameRequests(["d2d4", "d7d5"]), { priority: "backfill" })).resolves.toHaveLength(2);
  });

  it("hands each position to onResult as it resolves, and a throwing consumer fails the game", async () => {
    const { pool } = fakePool(1);
    const seen: number[] = [];
    await pool.analyseGame("g", gameRequests(GAME, 3), { priority: "backfill", onResult: (index) => seen.push(index) });
    expect(seen).toEqual([0, 1, 2]);

    const failing = pool.analyseGame("h", gameRequests(GAME, 3), {
      priority: "backfill",
      onResult: (index) => {
        if (index === 2) {
          throw new Error("disk full");
        }
      }
    });
    await expect(failing).rejects.toThrow("disk full");
    await expect(pool.analyseGame("next", gameRequests(["d2d4"], 1), { priority: "backfill" })).resolves.toHaveLength(1);
  });

  it("rejects an illegal move history at once", async () => {
    const { pool } = fakePool(1);
    await expect(pool.analyseGame("bad", [{ moves: ["e2e5"], tier: "owner" }], { priority: "backfill" })).rejects.toThrow(/Illegal move/);
  });

  it("rejects queued work and closes every engine on close", async () => {
    const { pool, engines } = fakePool(1, { delayMs: 20 });
    const running = pool.analyseGame("a", gameRequests(GAME), { priority: "backfill" });
    const queued = pool.analyseGame("b", gameRequests(GAME), { priority: "backfill" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await pool.close();
    await expect(queued).rejects.toThrow(EnginePoolClosedError);
    await expect(running).rejects.toThrow();
    expect(engines.every((engine) => engine.closed)).toBe(true);
    await expect(pool.analyse({ moves: [], tier: "owner" }, "interactive")).rejects.toThrow(EnginePoolClosedError);
  });

  it("reports the engine id name", async () => {
    const { pool, engines } = fakePool(2);
    expect(await pool.engineIdName()).toBe("Stockfish 18");
    expect(engines).toHaveLength(1);
    await pool.analyseGame("g", gameRequests(GAME, 2), { priority: "backfill" });
    // The idle engine spawned for the id is reused, not leaked.
    expect(engines).toHaveLength(1);
  });

  it("with real processes: a crash mid-search fails the game visibly after one respawn, no process left", async () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const spawned: UciEngine[] = [];
    const pool = new EnginePool({
      size: 1,
      spawn: async () => {
        const engine = await UciEngine.start({
          path: process.execPath,
          args: [path.join(root, "test/fake-uci.mjs"), path.join(root, "test/fixtures/uci-transcripts/crash-mid-search.txt")],
          threads: 1,
          hashMb: 64
        });
        spawned.push(engine);
        return engine;
      }
    });
    pools.push(pool);
    await expect(pool.analyse({ moves: [], tier: "owner" }, "interactive")).rejects.toThrow(/exited unexpectedly \(code 9\)/);
    expect(spawned).toHaveLength(2);
    expect(spawned.every((engine) => !engine.alive)).toBe(true);
  });
});

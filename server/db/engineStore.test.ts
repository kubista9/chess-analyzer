import { afterEach, describe, expect, it } from "vitest";
import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import { scoreWinPercent } from "../../shared/eval.js";
import type { EngineLine, PositionEval } from "../../shared/types.js";
import { gameId, loadOwnerGames } from "../../test/loadFixtures.js";
import { currentEngineConfig, engineConfigKey } from "../engine/engineConfig.js";
import { ENGINE_PROTOCOL } from "../engine/protocol.js";
import { deriveMonth, utcMonth } from "../services/gameDerive.js";
import { openDatabase, type Db } from "./connection.js";
import { getOrCreateEngineConfig, listEngineConfigs } from "./engineConfigs.js";
import { countAnalysisQueue, getGameAnalysis, listAnalysisQueue, recordGameAnalysis, type AnalysisQueueQuery } from "./gameAnalysis.js";
import { listGames, replaceMonthGames } from "./games.js";
import { averageNodes, countPositions, getDeepEval, getPositionEval, listPositionEvals, positionsStamp, putPositionEval } from "./positions.js";
import { DEEP_TIER, canonicalJson } from "../engine/protocol.js";

const OWNER = "kubista9";
const opened: Db[] = [];

afterEach(() => {
  opened.splice(0).forEach((db) => db.close());
});

function memoryDb(): Db {
  const db = openDatabase(":memory:");
  opened.push(db);
  return db;
}

/** A store with the 8 real fixture games. */
function store(): Db {
  const db = memoryDb();
  const byMonth = new Map<string, unknown[]>();
  for (const game of loadOwnerGames()) {
    const month = utcMonth(game.end_time);
    byMonth.set(month, [...(byMonth.get(month) ?? []), game]);
  }
  for (const [month, games] of byMonth) {
    replaceMonthGames(db, OWNER, month, deriveMonth(OWNER, month, games).games, "archive");
  }
  return db;
}

function line(uci: string, cp: number | null, mate: number | null = null): EngineLine {
  return { uci, cp, mate, winPct: scoreWinPercent({ cp, mate }), depth: 15, pv: [uci, "e7e5"] };
}

describe("engine configs", () => {
  it("creates a config once per (engine version, protocol) and returns it afterwards", () => {
    const db = memoryDb();
    const first = currentEngineConfig(db, "Stockfish 18");
    expect(first).toMatchObject({ id: 1, engineName: "Stockfish", engineVersion: "18", openingPlies: OPENING_PLY_LIMIT });
    expect(JSON.parse(first.protocolJson)).toEqual(ENGINE_PROTOCOL);
    expect(currentEngineConfig(db, "Stockfish 18")).toEqual(first);
    expect(listEngineConfigs(db)).toHaveLength(1);
  });

  it("gives a new engine version or a new protocol a new config and keeps the old ones", () => {
    const db = memoryDb();
    const sf18 = currentEngineConfig(db, "Stockfish 18");
    const sf19 = currentEngineConfig(db, "Stockfish 19");
    const deeper = getOrCreateEngineConfig(db, {
      ...engineConfigKey("Stockfish 18"),
      protocol: { ...ENGINE_PROTOCOL, tiers: { ...ENGINE_PROTOCOL.tiers, owner: { multipv: 3, depth: 16 } } }
    });
    expect(new Set([sf18.id, sf19.id, deeper.id]).size).toBe(3);
    expect(listEngineConfigs(db).map((config) => config.engineVersion)).toEqual(["18", "19", "18"]);
  });

  it("matches protocols by content, not key order", () => {
    const db = memoryDb();
    const a = getOrCreateEngineConfig(db, { engineName: "Stockfish", engineVersion: "18", protocol: { a: 1, b: { c: 2, d: 3 } }, openingPlies: 20 });
    const b = getOrCreateEngineConfig(db, { engineName: "Stockfish", engineVersion: "18", protocol: { b: { d: 3, c: 2 }, a: 1 }, openingPlies: 20 });
    expect(b.id).toBe(a.id);
  });
});

describe("positions", () => {
  const epd = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -";
  const owner: PositionEval = {
    epd,
    tier: "owner",
    depth: 15,
    nodes: 351234,
    lines: [line("b8c6", -42), line("g8f6", -50), line("d7d6", -55)],
    scored: [line("f8c5", -166)],
    terminal: null,
    bestUci: "b8c6",
    score: { cp: -42, mate: null }
  };

  it("round-trips an eval with its scored moves", () => {
    const db = memoryDb();
    const config = currentEngineConfig(db, "Stockfish 18");
    putPositionEval(db, config.id, owner, 1000);
    expect(getPositionEval(db, config.id, epd, "owner")).toEqual(owner);
    expect(countPositions(db, config.id)).toEqual({ owner: 1, opponent: 0 });
  });

  it("serves an owner-tier row to an opponent-tier request, never the reverse", () => {
    const db = memoryDb();
    const config = currentEngineConfig(db, "Stockfish 18");
    const opponent: PositionEval = { ...owner, tier: "opponent", depth: 14, lines: [line("b8c6", -40)], scored: [] };
    putPositionEval(db, config.id, opponent);
    expect(getPositionEval(db, config.id, epd, "opponent")?.tier).toBe("opponent");
    expect(getPositionEval(db, config.id, epd, "owner")).toBeUndefined();
    putPositionEval(db, config.id, owner);
    expect(getPositionEval(db, config.id, epd, "opponent")?.tier).toBe("owner");
    expect(countPositions(db, config.id)).toEqual({ owner: 1, opponent: 1 });
  });

  it("keeps the deep tier apart: same config, only getDeepEval reads it, and no count, stamp or listing sees it", () => {
    const db = memoryDb();
    const config = currentEngineConfig(db, "Stockfish 18");
    putPositionEval(db, config.id, owner, 1000);
    const stamp = positionsStamp(db, config.id);
    const deep: PositionEval = { ...owner, tier: "deep", depth: DEEP_TIER.depth, nodes: 1_600_000, lines: [...owner.lines, line("d7d5", -106)] };
    putPositionEval(db, config.id, deep, 2000);
    expect(getDeepEval(db, config.id, epd)).toEqual(deep);
    expect(getPositionEval(db, config.id, epd, "owner")).toEqual(owner);
    expect(countPositions(db, config.id)).toEqual({ owner: 1, opponent: 0 });
    expect(positionsStamp(db, config.id)).toEqual(stamp);
    expect(listPositionEvals(db, config.id).map((row) => row.tier)).toEqual(["owner"]);
    expect(averageNodes(db, config.id).owner.mean).toBe(owner.nodes);
    // The deep tier is not part of the protocol, so the config key (and every game's queue) is unchanged.
    expect(canonicalJson(ENGINE_PROTOCOL)).not.toContain("deep");
    expect(currentEngineConfig(db, "Stockfish 18").id).toBe(config.id);
  });

  it("upgrades a row in place when more moves are scored, and keeps configs apart", () => {
    const db = memoryDb();
    const config = currentEngineConfig(db, "Stockfish 18");
    const other = currentEngineConfig(db, "Stockfish 19");
    putPositionEval(db, config.id, { ...owner, scored: [] });
    putPositionEval(db, config.id, owner, 2000);
    expect(getPositionEval(db, config.id, epd, "owner")?.scored.map((scored) => scored.uci)).toEqual(["f8c5"]);
    expect(countPositions(db, config.id).owner).toBe(1);
    expect(getPositionEval(db, other.id, epd, "owner")).toBeUndefined();
  });

  it("merges scored moves when two writers extended the same search, and replaces a different search", () => {
    const db = memoryDb();
    const config = currentEngineConfig(db, "Stockfish 18");
    // Two processes read the row without f8c5, then each adds a different follow-up.
    putPositionEval(db, config.id, { ...owner, scored: [line("f8c5", -166)] });
    putPositionEval(db, config.id, { ...owner, scored: [line("h7h6", -90)] });
    expect(getPositionEval(db, config.id, epd, "owner")?.scored.map((scored) => scored.uci)).toEqual(["h7h6", "f8c5"]);
    // A fresh main search with other lines replaces the row, follow-ups and all.
    putPositionEval(db, config.id, { ...owner, lines: [line("g8f6", -40), line("b8c6", -44), line("d7d6", -55)], scored: [] });
    expect(getPositionEval(db, config.id, epd, "owner")?.scored).toEqual([]);
  });

  it("stores terminal positions with mate 0 and no best move", () => {
    const db = memoryDb();
    const config = currentEngineConfig(db, "Stockfish 18");
    const mated: PositionEval = { ...owner, epd: "mated", depth: 0, nodes: 0, lines: [], scored: [], terminal: "checkmate", bestUci: null, score: { cp: null, mate: 0 } };
    putPositionEval(db, config.id, mated);
    expect(getPositionEval(db, config.id, "mated", "owner")).toEqual(mated);
  });
});

describe("the analysis work queue (incremental rule)", () => {
  // The 8 fixture games end between 2025-11 and 2026-09; the window covers all of them.
  const query = (configId: number, extra: Partial<AnalysisQueueQuery> = {}): AnalysisQueueQuery => ({
    username: OWNER,
    configId,
    windowStart: 0,
    openingPlies: OPENING_PLY_LIMIT,
    ...extra
  });

  it("lists every window game newest first, and excludes games analysed under the config", () => {
    const db = store();
    const config = currentEngineConfig(db, "Stockfish 18");
    const all = listGames(db, OWNER, { start: 0, end: 2_000_000_000 });
    const queue = listAnalysisQueue(db, query(config.id));
    expect(queue.map((game) => game.id)).toEqual(all.map((game) => game.id));
    expect(queue.map((game) => game.endTime)).toEqual([...queue.map((game) => game.endTime)].sort((a, b) => b - a));

    recordGameAnalysis(db, { gameId: queue[0].id, configId: config.id, plies: 20, analyzedAt: 1, summary: { positions: 20 } });
    recordGameAnalysis(db, { gameId: queue[3].id, configId: config.id, plies: 20, analyzedAt: 1, summary: null });
    const next = listAnalysisQueue(db, query(config.id));
    expect(next.map((game) => game.id)).toEqual(queue.filter((_, index) => index !== 0 && index !== 3).map((game) => game.id));
    expect(countAnalysisQueue(db, query(config.id))).toBe(queue.length - 2);
    expect(listAnalysisQueue(db, query(config.id, { limit: 2 })).map((game) => game.id)).toEqual(next.slice(0, 2).map((game) => game.id));
    expect(getGameAnalysis(db, queue[0].id, config.id)?.summary).toEqual({ positions: 20 });
  });

  it("re-queues the whole window under a new config and keeps the old config's rows", () => {
    const db = store();
    const sf18 = currentEngineConfig(db, "Stockfish 18");
    for (const game of listAnalysisQueue(db, query(sf18.id))) {
      recordGameAnalysis(db, { gameId: game.id, configId: sf18.id, plies: Math.min(20, game.plyCount), analyzedAt: 1, summary: {} });
    }
    expect(countAnalysisQueue(db, query(sf18.id))).toBe(0);

    const sf19 = currentEngineConfig(db, "Stockfish 19");
    expect(countAnalysisQueue(db, query(sf19.id))).toBe(8);
    expect(countAnalysisQueue(db, query(sf18.id))).toBe(0);
  });

  it("applies the window bounds", () => {
    const db = store();
    const config = currentEngineConfig(db, "Stockfish 18");
    const queue = listAnalysisQueue(db, query(config.id));
    const cut = queue[2].endTime;
    expect(listAnalysisQueue(db, query(config.id, { windowStart: cut })).map((game) => game.id)).toEqual(
      queue.slice(0, 3).map((game) => game.id)
    );
    expect(countAnalysisQueue(db, query(config.id, { windowStart: cut, windowEnd: cut }))).toBe(1);
  });

  it("counts a short game as done at its length, and re-queues games when the opening window grows", () => {
    const db = store();
    const config = currentEngineConfig(db, "Stockfish 18");
    const games = listAnalysisQueue(db, query(config.id));
    for (const game of games) {
      recordGameAnalysis(db, { gameId: game.id, configId: config.id, plies: Math.min(20, game.plyCount), analyzedAt: 1, summary: {} });
    }
    expect(countAnalysisQueue(db, query(config.id))).toBe(0);
    const longEnough = games.filter((game) => game.plyCount > 20).length;
    expect(countAnalysisQueue(db, query(config.id, { openingPlies: 24 }))).toBe(longEnough);
  });

  it("keeps game_analysis rows when a month is re-derived (games deleted and re-inserted)", () => {
    const db = store();
    const config = currentEngineConfig(db, "Stockfish 18");
    const raw = loadOwnerGames()[0];
    const id = gameId(raw);
    recordGameAnalysis(db, { gameId: id, configId: config.id, plies: 20, analyzedAt: 1, summary: {} });
    const month = utcMonth(raw.end_time);
    const monthGames = loadOwnerGames().filter((game) => utcMonth(game.end_time) === month);
    replaceMonthGames(db, OWNER, month, deriveMonth(OWNER, month, monthGames).games, "archive");
    expect(getGameAnalysis(db, id, config.id)).toBeDefined();
    expect(listAnalysisQueue(db, query(config.id)).map((game) => game.id)).not.toContain(id);
  });
});

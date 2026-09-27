import { afterEach, describe, expect, it } from "vitest";
import { START_EPD } from "../../shared/epd.js";
import { scoreWinPercent } from "../../shared/eval.js";
import type { EngineLine, PositionEval } from "../../shared/types.js";
import { legalFakePool } from "../../test/fakeEngine.js";
import { FIXTURE_OWNER, fixtureStore } from "../../test/fixtureStore.js";
import type { Db } from "../db/connection.js";
import { getGameAnalysis } from "../db/gameAnalysis.js";
import { listOpeningMoves } from "../db/games.js";
import { getPositionEval, putPositionEval } from "../db/positions.js";
import { currentEngineConfig } from "../engine/engineConfig.js";
import type { EnginePool } from "../engine/pool.js";
import {
  evaluateOpening,
  isAnswered,
  openingPositions,
  positionKey,
  recordOpeningFromStore,
  summariseOpening,
  type OpeningPosition
} from "./openingPass.js";

const pools: EnginePool[] = [];
const dbs: Db[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  dbs.splice(0).forEach((db) => db.close());
});

function line(uci: string, cp: number | null, mate: number | null = null): EngineLine {
  return { uci, cp, mate, winPct: scoreWinPercent({ cp, mate }), depth: 15, pv: [uci] };
}

function evalOf(position: OpeningPosition, lines: EngineLine[], scored: EngineLine[] = []): PositionEval {
  return {
    epd: position.epd,
    tier: position.tier,
    depth: 15,
    nodes: 100,
    lines,
    scored,
    terminal: null,
    bestUci: lines[0].uci,
    score: { cp: lines[0].cp, mate: lines[0].mate }
  };
}

/** The first fixture game as the owner played it, with its stored opening moves. */
function firstGame(db: Db) {
  const [id, moves] = [...listOpeningMoves(db, FIXTURE_OWNER, 0, 20)][0];
  return { id, ...moves, positions: openingPositions(moves.plies, moves.color) };
}

describe("openingPositions", () => {
  it("gives the positions before plies 1..L with the mover's tier and the move history", () => {
    const moves = [
      { uci: "e2e4", san: "e4", epdBefore: START_EPD },
      { uci: "d7d5", san: "d5", epdBefore: "e1" },
      { uci: "e4d5", san: "exd5", epdBefore: "e2" }
    ];
    const positions = openingPositions(moves, "black");
    expect(positions.map((position) => [position.ply, position.mover, position.tier, position.moves.join(" "), position.played])).toEqual([
      [1, "white", "opponent", "", "e2e4"],
      [2, "black", "owner", "e2e4", "d7d5"],
      [3, "white", "opponent", "e2e4 d7d5", "e4d5"]
    ]);
    expect(openingPositions(moves, "white", 2).map((position) => position.tier)).toEqual(["owner", "opponent"]);
    expect(positionKey(positions[0])).toBe(`opponent|${START_EPD}`);
  });
});

describe("isAnswered", () => {
  const position = openingPositions([{ uci: "e2e4", san: "e4", epdBefore: START_EPD }], "white")[0];

  it("needs lines and every played move scored", () => {
    const evaluation = evalOf(position, [line("d2d4", 30), line("e2e4", 28)], [line("a2a3", -10)]);
    expect(isAnswered(evaluation, ["e2e4", "a2a3"])).toBe(true);
    expect(isAnswered(evaluation, ["e2e4", "g2g4"])).toBe(false);
    expect(isAnswered(undefined, [])).toBe(false);
    expect(isAnswered({ ...evaluation, lines: [], terminal: "checkmate" }, ["e2e4"])).toBe(true);
  });
});

describe("summariseOpening", () => {
  it("finds the owner's first opening error and gives evals from the owner's side", () => {
    const db = fixtureStore();
    dbs.push(db);
    const game = firstGame(db);
    // Every best line is +0.30 for the side to move; the played move is scored at +0.10 (good),
    // except the owner's third move, which drops to -4.00 (a blunder).
    const ownerMoves = game.positions.filter((position) => position.tier === "owner");
    const blunder = ownerMoves[2];
    const evals = game.positions.map((position) =>
      evalOf(position, [line("zzzz", 30)], [line(position.played, position === blunder ? -400 : 10)])
    );
    const summary = summariseOpening(game.positions, evals, game.color);

    expect(summary).toMatchObject({ version: 1, color: game.color, plies: game.positions.length });
    expect(summary.owner.moves).toBe(ownerMoves.length);
    expect(summary.owner.firstError).toMatchObject({ ply: blunder.ply, san: blunder.san, uci: blunder.played, category: "blunder" });
    expect(summary.owner.worst?.ply).toBe(blunder.ply);
    expect(summary.owner.categories.blunder).toBe(1);
    expect(summary.owner.categories.good).toBe(ownerMoves.length - 1);
    expect(summary.opponent.firstError).toBeNull();
    expect(summary.opponent.categories.good).toBe(game.positions.length - ownerMoves.length);
    expect(summary.owner.accuracy).toBeGreaterThan(0);
    expect(summary.owner.accuracy).toBeLessThan(100);

    // After a move the mover stands at +0.10 (the played move's score at its root), so the
    // owner is at +0.10 after his own moves and at -0.10 after the opponent's.
    expect(summary.evalAfter.map((entry) => entry.ply)).toEqual([12, 16, 20].filter((ply) => ply <= game.positions.length));
    for (const entry of summary.evalAfter) {
      const ownerMoved = game.positions[entry.ply - 1].tier === "owner";
      if (entry.ply - 1 === blunder.index) {
        continue;
      }
      expect(entry.cp).toBe(ownerMoved ? 10 : -10);
      expect(entry.winPct > 50).toBe(ownerMoved);
    }
  });

  it("refuses a position whose played move is not scored", () => {
    const position = openingPositions([{ uci: "e2e4", san: "e4", epdBefore: START_EPD }], "white")[0];
    expect(() => summariseOpening([position], [evalOf(position, [line("d2d4", 30)])], "white")).toThrow(/not scored/);
  });
});

describe("evaluateOpening", () => {
  it("serves cached positions without the engine, searches only what is missing, and stores it", async () => {
    const db = fixtureStore();
    dbs.push(db);
    const { pool, log } = legalFakePool({ size: 1 });
    pools.push(pool);
    const config = currentEngineConfig(db, "Stockfish 18");
    const game = firstGame(db);
    const items = game.positions.map((position) => ({ position, played: [position.played] }));

    const first = await evaluateOpening({ db, pool, configId: config.id }, "g", items, { priority: "interactive" });
    expect(first).toHaveLength(game.positions.length);
    const searches = log.length;
    expect(searches).toBeGreaterThanOrEqual(game.positions.length);
    for (const position of game.positions) {
      expect(isAnswered(getPositionEval(db, config.id, position.epd, position.tier), [position.played])).toBe(true);
    }

    // All cached: no search at all, and the same evals.
    const events: boolean[] = [];
    const second = await evaluateOpening({ db, pool, configId: config.id }, "g", items, {
      priority: "interactive",
      onEvaluated: (_index, _evaluation, info) => events.push(info.searched)
    });
    expect(log).toHaveLength(searches);
    expect(events.every((searched) => !searched)).toBe(true);
    expect(second.map((evaluation) => evaluation.lines)).toEqual(first.map((evaluation) => evaluation.lines));

    // A new move at a cached position: only the searchmoves follow-up runs, on the same row.
    const [start] = game.positions;
    const other = { ...start, played: "h2h3" };
    await evaluateOpening({ db, pool, configId: config.id }, "g2", [{ position: other, played: ["h2h3"] }], { priority: "backfill" });
    expect(log.slice(searches)).toEqual([{ moves: [], multipv: 1, searchmoves: ["h2h3"] }]);
    expect(isAnswered(getPositionEval(db, config.id, start.epd, start.tier), [start.played, "h2h3"])).toBe(true);
  });

  it("records a game's analysis only when every position is answered in the store", async () => {
    const db = fixtureStore();
    dbs.push(db);
    const config = currentEngineConfig(db, "Stockfish 18");
    const game = firstGame(db);
    const evals = game.positions.map((position) => evalOf(position, [line("zzzz", 20)], [line(position.played, 10)]));
    evals.slice(0, -1).forEach((evaluation) => putPositionEval(db, config.id, evaluation));
    expect(recordOpeningFromStore(db, config.id, game.id, game.positions, game.color)).toBeNull();
    expect(getGameAnalysis(db, game.id, config.id)).toBeUndefined();

    putPositionEval(db, config.id, evals[evals.length - 1]);
    const summary = recordOpeningFromStore(db, config.id, game.id, game.positions, game.color);
    expect(summary).not.toBeNull();
    expect(getGameAnalysis(db, game.id, config.id)).toMatchObject({ plies: game.positions.length, summary });
  });
});

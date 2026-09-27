import { describe, expect, it } from "vitest";
import { START_EPD } from "../../shared/epd.js";
import { classifyLoss, scoreWinPercent } from "../../shared/eval.js";
import type { EngineLine } from "../../shared/types.js";
import { analysePosition, lineFor, playedLoss, replayUci, type SearchEngine } from "./analysePosition.js";
import { ENGINE_PROTOCOL, canonicalJson, searchTimeoutMs } from "./protocol.js";
import type { SearchRequest, SearchResult } from "./uci.js";

function line(uci: string, cp: number | null, depth = 15, mate: number | null = null): EngineLine {
  return { uci, cp, mate, winPct: scoreWinPercent({ cp, mate }), depth, pv: [uci] };
}

/** An in-memory engine: answers each search with `answer(request)` and records the requests. */
function scriptedEngine(answer: (request: SearchRequest) => EngineLine[]): SearchEngine & { requests: SearchRequest[] } {
  const requests: SearchRequest[] = [];
  return {
    requests,
    async search(request): Promise<SearchResult> {
      requests.push(request);
      const lines = answer(request);
      return { lines, depth: lines[0]?.depth ?? 0, complete: true, nodes: 1000, bestmove: lines[0]?.uci ?? null, ms: 1 };
    }
  };
}

const E4_E5_NF3 = ["e2e4", "e7e5", "g1f3"];
const TOP3 = [line("b8c6", -42), line("g8f6", -50), line("d7d6", -55)];

describe("analysePosition", () => {
  it("resolves checkmate without the engine (mate 0 for the side to move)", async () => {
    const engine = scriptedEngine(() => {
      throw new Error("the engine must not be called");
    });
    const evaluation = await analysePosition(engine, { moves: ["f2f3", "e7e5", "g2g4", "d8h4"], tier: "owner", played: [] });
    expect(evaluation).toMatchObject({ terminal: "checkmate", score: { cp: null, mate: 0 }, lines: [], bestUci: null, depth: 0 });
  });

  it("resolves stalemate without the engine (cp 0)", async () => {
    // Sam Loyd's 10-move stalemate: 1.e3 a5 2.Qh5 Ra6 3.Qxa5 h5 4.h4 Rah6 5.Qxc7 f6 6.Qxd7+ Kf7
    // 7.Qxb7 Qd3 8.Qxb8 Qh7 9.Qxc8 Kg6 10.Qe6.
    const moves = "e2e3 a7a5 d1h5 a8a6 h5a5 h7h5 h2h4 a6h6 a5c7 f7f6 c7d7 e8f7 d7b7 d8d3 b7b8 d3h7 b8c8 f7g6 c8e6".split(" ");
    const engine = scriptedEngine(() => {
      throw new Error("the engine must not be called");
    });
    const evaluation = await analysePosition(engine, { moves, tier: "opponent" });
    expect(evaluation).toMatchObject({ terminal: "stalemate", score: { cp: 0, mate: null }, lines: [] });
  });

  it("searches the tier's MultiPV at its fixed depth, with the node cap as a guard", async () => {
    const engine = scriptedEngine(() => TOP3);
    const evaluation = await analysePosition(engine, { moves: E4_E5_NF3, tier: "owner", played: ["b8c6"] });
    expect(engine.requests).toEqual([
      {
        moves: E4_E5_NF3,
        multipv: 3,
        expectedRanks: 3,
        depth: ENGINE_PROTOCOL.tiers.owner.depth,
        nodes: ENGINE_PROTOCOL.nodeCap,
        timeoutMs: searchTimeoutMs()
      }
    ]);
    expect(evaluation).toMatchObject({ tier: "owner", depth: 15, bestUci: "b8c6", score: { cp: -42, mate: null }, scored: [] });
    expect(evaluation.epd).toBe("rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -");
    expect(playedLoss(evaluation, "b8c6")).toBe(0);
  });

  it("scores a played move outside the top K with depth-matched searchmoves on the same root", async () => {
    const engine = scriptedEngine((request) => (request.searchmoves ? [line("f8c5", -166)] : TOP3));
    const evaluation = await analysePosition(engine, { moves: E4_E5_NF3, tier: "owner", played: ["f8c5", "b8c6", "f8c5"] });
    expect(engine.requests).toHaveLength(2);
    expect(engine.requests[1]).toMatchObject({ multipv: 1, expectedRanks: 1, depth: 15, searchmoves: ["f8c5"], moves: E4_E5_NF3 });
    expect(lineFor(evaluation, "f8c5")).toMatchObject({ cp: -166, depth: 15 });
    expect(evaluation.nodes).toBe(2000);
    const loss = playedLoss(evaluation, "f8c5")!;
    expect(loss).toBeCloseTo(10.96, 1);
    expect(classifyLoss(loss)).toBe("mistake");
  });

  it("matches the searchmoves depth to the lines' depth when the node cap cut the main search short", async () => {
    const engine = scriptedEngine((request) => (request.searchmoves ? [line("f8c5", -150, 13)] : TOP3.map((top) => ({ ...top, depth: 13 }))));
    await analysePosition(engine, { moves: E4_E5_NF3, tier: "owner", played: ["f8c5"] });
    expect(engine.requests[1].depth).toBe(13);
  });

  it("scores several missing moves in one search with MultiPV = their count", async () => {
    const engine = scriptedEngine((request) =>
      request.searchmoves ? [line("f8c5", -166), line("d8f6", -210)] : TOP3
    );
    const evaluation = await analysePosition(engine, { moves: E4_E5_NF3, tier: "owner", played: ["d8f6", "f8c5"] });
    expect(engine.requests[1]).toMatchObject({ multipv: 2, expectedRanks: 2, searchmoves: ["d8f6", "f8c5"] });
    expect(evaluation.scored.map((scored) => scored.uci).sort()).toEqual(["d8f6", "f8c5"]);
  });

  it("with a cached eval runs only the searchmoves for a newly played move", async () => {
    const engine = scriptedEngine(() => [line("f8c5", -166)]);
    const cached = await analysePosition(scriptedEngine(() => TOP3), { moves: E4_E5_NF3, tier: "owner" });
    const evaluation = await analysePosition(engine, { moves: E4_E5_NF3, tier: "opponent", played: ["f8c5"], cached });
    expect(engine.requests).toHaveLength(1);
    expect(engine.requests[0].searchmoves).toEqual(["f8c5"]);
    // An owner-tier row answers an opponent-tier request and keeps its tier.
    expect(evaluation.tier).toBe("owner");
    expect(cached.scored).toEqual([]);
  });

  it("asks for fewer ranks when fewer moves are legal", async () => {
    // 1.e4 f5 2.Qh5+: g7g6 is Black's only legal move.
    const engine = scriptedEngine(() => [line("g7g6", -300)]);
    await analysePosition(engine, { moves: ["e2e4", "f7f5", "d1h5"], tier: "owner" });
    expect(engine.requests[0]).toMatchObject({ multipv: 3, expectedRanks: 1 });
  });

  it("fails loudly when the engine returns nothing for a live position", async () => {
    await expect(analysePosition(scriptedEngine(() => []), { moves: [], tier: "owner" })).rejects.toThrow(/no line/);
  });

  it("rejects illegal move histories", () => {
    expect(() => replayUci(["e2e5"])).toThrow(/Illegal move e2e5 at ply 1/);
    expect(replayUci([]).epd).toBe(START_EPD);
  });
});

describe("protocol", () => {
  it("is fixed-depth, single-thread, Hash 64, depth-matched searchmoves", () => {
    expect(ENGINE_PROTOCOL).toMatchObject({
      threads: 1,
      hashMb: 64,
      tiers: { owner: { multipv: 3, depth: 15 }, opponent: { multipv: 1, depth: 14 } },
      searchmoves: "depth-matched"
    });
  });

  it("serialises canonically, whatever the key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"e":3,"f":2}]},"b":1}');
    expect(canonicalJson(ENGINE_PROTOCOL)).toBe(canonicalJson(JSON.parse(JSON.stringify(ENGINE_PROTOCOL))));
  });
});

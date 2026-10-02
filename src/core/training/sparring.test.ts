import { describe, expect, it } from "vitest";
import { START_FEN, uciToSan, type AppliedMove } from "../chess/position";
import type { RepertoireTree } from "../content/types";
import type { AnalyseOptions, AnalysedLine, Analysis, EngineClient, MoveScore } from "../engine/types";
import { buildBook, parseBookTsv } from "../openingDb/book";
import { seededRng } from "../util/random";
import { BOOK_TOP_MOVES, LEVEL_WINDOW, SPARRING_MULTI_PV, chooseOpponentMove, summariseSparring, type SparringContext } from "./sparring";
import { makeLine, makeTree, playMoves } from "./testing";
import type { SparringLevel } from "./types";

const BOOK = buildBook(
  parseBookTsv(
    [
      "eco\tname\tpgn",
      "B00\tKing's Pawn Game\t1. e4",
      "B10\tCaro-Kann Defense\t1. e4 c6",
      "B12\tCaro-Kann Defense: Advance Variation\t1. e4 c6 2. d4 d5 3. e5",
      "B12\tCaro-Kann Defense: Advance Variation, Short\t1. e4 c6 2. d4 d5 3. e5 c5",
      "B12\tCaro-Kann Defense: Advance Variation, Main\t1. e4 c6 2. d4 d5 3. e5 Bf5",
      "B12\tCaro-Kann Defense: Advance Variation, Short System\t1. e4 c6 2. d4 d5 3. e5 Bf5 4. Nf3",
      "B13\tCaro-Kann Defense: Exchange Variation\t1. e4 c6 2. d4 d5 3. exd5",
      "B15\tCaro-Kann Defense: Main Line\t1. e4 c6 2. d4 d5 3. Nc3",
      "B15\tCaro-Kann Defense: Main Line, Classical\t1. e4 c6 2. d4 d5 3. Nc3 dxe4",
      "B12\tCaro-Kann Defense: Maroczy Variation\t1. e4 c6 2. d4 d5 3. f3",
      ""
    ].join("\n")
  )
);

// The user plays Black: 1.e4 c6 2.d4 d5 (main), 1.d4 d5 2.c4 c6 (secondary), 1.c4 e5 (sideline).
const CARO = makeLine({ id: "caro", side: "black", moves: "1.e4 c6 2.d4 d5", priority: "main", order: 1 });
const SLAV = makeLine({ id: "slav", side: "black", moves: "1.d4 d5 2.c4 c6", priority: "secondary", order: 2 });
const ENGLISH = makeLine({ id: "english", side: "black", moves: "1.c4 e5", priority: "sideline", order: 3 });
const TREE = makeTree("black", [CARO, SLAV, ENGLISH]);

const AFTER_CARO = playMoves("1.e4 c6 2.d4 d5");
const CARO_FEN = AFTER_CARO[AFTER_CARO.length - 1].fenAfter;
const OUT_OF_BOOK = playMoves("1.e4 c6 2.d4 d5 3.e5 Bf5 4.Nf3 e6");
const OUT_FEN = OUT_OF_BOOK[OUT_OF_BOOK.length - 1].fenAfter;

class FakeEngine implements EngineClient {
  readonly analyseCalls: { fen: string; options?: AnalyseOptions }[] = [];
  readonly scoreCalls: { fen: string; uci: string }[] = [];

  constructor(
    private readonly winPcts: readonly [string, number][],
    private readonly losses: Record<string, number> = {},
    private readonly failure: Error | null = null
  ) {}

  async analyse(fen: string, options?: AnalyseOptions): Promise<Analysis> {
    this.analyseCalls.push({ fen, options });
    if (this.failure) {
      throw this.failure;
    }
    const lines = this.winPcts.slice(0, options?.multiPv ?? 1).map(([uci, winPct]) => line(fen, uci, winPct));
    return { fen, depth: 16, lines, complete: true, terminal: null };
  }

  async scoreMove(fen: string, uci: string): Promise<MoveScore> {
    this.scoreCalls.push({ fen, uci });
    const loss = this.losses[uci];
    if (loss === undefined) {
      throw new Error(`unexpected scoreMove ${uci}`);
    }
    const [bestUci, bestWin] = this.winPcts[0];
    return { fen, uci, best: line(fen, bestUci, bestWin), played: line(fen, uci, bestWin - loss), loss, depth: 16 };
  }
}

function line(fen: string, uci: string, winPct: number): AnalysedLine {
  const san = uciToSan(fen, uci) ?? uci;
  return { uci, cp: 0, mate: null, winPct, depth: 16, pv: [uci], san, pvSan: [san] };
}

function context(overrides: Partial<SparringContext> & { seed?: number }): SparringContext {
  const { seed, ...rest } = overrides;
  return {
    fen: START_FEN,
    history: [],
    tree: TREE,
    book: BOOK,
    rng: seededRng(seed ?? 1),
    engine: null,
    level: "club",
    movetimeMs: 300,
    ...rest
  };
}

/** How often each SAN is chosen over `runs` seeds. */
async function tally(overrides: Partial<SparringContext>, runs = 300): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (let seed = 1; seed <= runs; seed += 1) {
    const choice = await chooseOpponentMove(context({ ...overrides, seed }));
    const key = choice ? `${choice.source}:${choice.san}` : "null";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe("chooseOpponentMove: the repertoire first", () => {
  it("plays the opponent's moves of the user's repertoire, weighted by line priority", async () => {
    const counts = await tally({});
    expect([...counts.keys()].sort()).toEqual(["repertoire:c4", "repertoire:d4", "repertoire:e4"]);
    // Weights 3 : 2 : 1.
    expect(counts.get("repertoire:e4")!).toBeGreaterThan(counts.get("repertoire:d4")!);
    expect(counts.get("repertoire:d4")!).toBeGreaterThan(counts.get("repertoire:c4")!);
    expect(counts.get("repertoire:e4")! / 300).toBeGreaterThan(0.4);
    expect(counts.get("repertoire:c4")! / 300).toBeLessThan(0.25);
  });

  it("reports the lines that expect the reply and the opening name", async () => {
    const choice = await chooseOpponentMove(context({ replyWeight: (edge) => (edge.san === "e4" ? 1 : 0) }));
    expect(choice).toEqual({ uci: "e2e4", san: "e4", source: "repertoire", lineIds: ["caro"], bookName: "King's Pawn Game" });
  });

  it("is deterministic for a seed", async () => {
    const first = await chooseOpponentMove(context({ seed: 99 }));
    const second = await chooseOpponentMove(context({ seed: 99 }));
    expect(first).toEqual(second);
  });

  it("uses replyWeight when given, and falls through to the book when every weight is 0", async () => {
    const onlySideline = await tally({ replyWeight: (edge) => (edge.priority === "sideline" ? 5 : 0) }, 30);
    expect([...onlySideline.keys()]).toEqual(["repertoire:c4"]);
    // The mini book only knows 1.e4 from the start.
    const fromBook = await chooseOpponentMove(context({ replyWeight: () => 0 }));
    expect(fromBook).toEqual({ uci: "e2e4", san: "e4", source: "book", lineIds: [], bookName: "King's Pawn Game" });
  });

  it("skips a repertoire edge that is not legal here", async () => {
    const start = TREE.nodes.get(CARO.epds[0])!;
    const broken: RepertoireTree = {
      ...TREE,
      nodes: new Map([...TREE.nodes, [start.epd, { ...start, edges: [{ ...start.edges[0], uci: "e2e5", san: "e5" }] }]])
    };
    const choice = await chooseOpponentMove(context({ tree: broken }));
    // No legal repertoire reply at the start and the mini book has 1.e4.
    expect(choice).toMatchObject({ source: "book", san: "e4", lineIds: [] });
  });
});

describe("chooseOpponentMove: the book", () => {
  const base = { fen: CARO_FEN, history: AFTER_CARO };

  it("without an engine picks among the top 3 book moves by line count, weighted by count", async () => {
    expect(BOOK_TOP_MOVES).toBe(3);
    const counts = await tally(base);
    // Lines through: 3.e5 4, 3.Nc3 2, 3.exd5 1, 3.f3 1 (exd5 wins the tie on UCI).
    expect([...counts.keys()].sort()).toEqual(["book:Nc3", "book:e5", "book:exd5"]);
    expect(counts.get("book:e5")!).toBeGreaterThan(counts.get("book:Nc3")!);
    expect(counts.get("book:Nc3")!).toBeGreaterThan(counts.get("book:exd5")!);
  });

  it("names the opening after the move", async () => {
    const choice = await chooseOpponentMove(context({ ...base, seed: 3 }));
    const names: Record<string, string> = {
      e5: "Caro-Kann Defense: Advance Variation",
      Nc3: "Caro-Kann Defense: Main Line",
      exd5: "Caro-Kann Defense: Exchange Variation"
    };
    expect(choice!.bookName).toBe(names[choice!.san]);
  });

  it("with an engine keeps only book moves within SOUND_LOSS of the best, weighted by count", async () => {
    // e5 and Nc3 within 5 win% of the best; exd5 6 below; f3 not in the lines (and not the top book move).
    const engine = new FakeEngine([
      ["b1c3", 55],
      ["e4e5", 52],
      ["g1f3", 51],
      ["e4d5", 49]
    ]);
    const counts = await tally({ ...base, engine });
    expect([...counts.keys()].sort()).toEqual(["book:Nc3", "book:e5"]);
    expect(engine.scoreCalls).toEqual([]);
    expect(engine.analyseCalls[0]).toEqual({ fen: CARO_FEN, options: { multiPv: SPARRING_MULTI_PV, movetimeMs: 300, signal: undefined } });
    expect(engine.analyseCalls).toHaveLength(300);
  });

  it("scores the top book move separately when the search missed it", async () => {
    const lines: [string, number][] = [
      ["b1c3", 55],
      ["g1f3", 54],
      ["e4d5", 53],
      ["f1d3", 52]
    ];
    const sound = new FakeEngine(lines, { e4e5: 2 });
    const kept = await tally({ ...base, engine: sound }, 100);
    expect([...kept.keys()].sort()).toEqual(["book:Nc3", "book:e5", "book:exd5"]);
    expect(sound.scoreCalls.every((call) => call.uci === "e4e5")).toBe(true);
    expect(sound.scoreCalls).toHaveLength(100);

    const unsound = new FakeEngine(lines, { e4e5: 8 });
    const dropped = await tally({ ...base, engine: unsound }, 100);
    expect([...dropped.keys()].sort()).toEqual(["book:Nc3", "book:exd5"]);
  });

  it("goes to the engine when no book move is sound, reusing the same search", async () => {
    const engine = new FakeEngine(
      [
        ["g1f3", 60],
        ["f1d3", 59],
        ["c2c3", 50],
        ["h2h3", 40]
      ],
      { e4e5: 12 }
    );
    const choice = await chooseOpponentMove(context({ ...base, engine, level: "club" }));
    expect(choice?.source).toBe("engine");
    expect(["Nf3", "Bd3"]).toContain(choice?.san);
    expect(choice?.lineIds).toEqual([]);
    expect(engine.analyseCalls).toHaveLength(1);
  });

  it("falls back to the book choice without the engine when the engine fails", async () => {
    const engine = new FakeEngine([], {}, new Error("engine crashed"));
    const counts = await tally({ ...base, engine }, 100);
    expect([...counts.keys()].sort()).toEqual(["book:Nc3", "book:e5", "book:exd5"]);
  });

  it("rejects when the search is aborted", async () => {
    const abort = new DOMException("The search was stopped", "AbortError");
    const engine = new FakeEngine([], {}, abort);
    await expect(chooseOpponentMove(context({ ...base, engine }))).rejects.toBe(abort);
    const controller = new AbortController();
    controller.abort();
    const failing = new FakeEngine([], {}, new Error("stopped"));
    await expect(chooseOpponentMove(context({ ...base, engine: failing, signal: controller.signal }))).rejects.toThrow("stopped");
  });
});

describe("chooseOpponentMove: the engine out of book", () => {
  const base = { fen: OUT_FEN, history: OUT_OF_BOOK };
  // Losses 0, 3, 8 and 15 win%.
  const LINES: [string, number][] = [
    ["f1e2", 60],
    ["c2c3", 57],
    ["f1d3", 52],
    ["h2h4", 45]
  ];

  it("picks within the level's window below the best, weighted towards the best", async () => {
    expect(LEVEL_WINDOW).toEqual({ relaxed: 12, club: 6, strong: 2.5, best: 0 });
    const expected: Record<SparringLevel, string[]> = {
      relaxed: ["engine:Bd3", "engine:Be2", "engine:c3"],
      club: ["engine:Be2", "engine:c3"],
      strong: ["engine:Be2"],
      best: ["engine:Be2"]
    };
    for (const level of Object.keys(expected) as SparringLevel[]) {
      const counts = await tally({ ...base, engine: new FakeEngine(LINES), level });
      expect([level, [...counts.keys()].sort()]).toEqual([level, expected[level]]);
      if (level === "relaxed") {
        expect(counts.get("engine:Be2")!).toBeGreaterThan(counts.get("engine:c3")!);
        expect(counts.get("engine:c3")!).toBeGreaterThan(counts.get("engine:Bd3")!);
      }
    }
  });

  it("includes a move exactly at the window's edge", async () => {
    const edge: [string, number][] = [
      ["f1e2", 60],
      ["c2c3", 57.5],
      ["f1d3", 57.4]
    ];
    const counts = await tally({ ...base, engine: new FakeEngine(edge), level: "strong" });
    expect([...counts.keys()].sort()).toEqual(["engine:Be2", "engine:c3"]);
  });

  it("asks for SPARRING_MULTI_PV lines with the given time and signal", async () => {
    const engine = new FakeEngine(LINES);
    const controller = new AbortController();
    const choice = await chooseOpponentMove(context({ ...base, engine, signal: controller.signal }));
    expect(engine.analyseCalls).toEqual([{ fen: OUT_FEN, options: { multiPv: 4, movetimeMs: 300, signal: controller.signal } }]);
    // The game's opening name so far.
    expect(choice?.bookName).toBe("Caro-Kann Defense: Advance Variation, Short System");
  });

  it("an engine failure out of book rejects (there is no fallback)", async () => {
    await expect(chooseOpponentMove(context({ ...base, engine: new FakeEngine([], {}, new Error("engine crashed")) }))).rejects.toThrow("engine crashed");
  });

  it("returns null out of book without an engine, or when the engine has no line", async () => {
    expect(await chooseOpponentMove(context(base))).toBeNull();
    expect(await chooseOpponentMove(context({ ...base, book: null }))).toBeNull();
    expect(await chooseOpponentMove(context({ fen: CARO_FEN, history: AFTER_CARO, book: null }))).toBeNull();
    expect(await chooseOpponentMove(context({ ...base, engine: new FakeEngine([]) }))).toBeNull();
  });

  it("returns null when the game is over, without asking the engine", async () => {
    const mated = playMoves("1.f3 e5 2.g4 Qh4#");
    const engine = new FakeEngine(LINES);
    expect(await chooseOpponentMove(context({ fen: mated[3].fenAfter, history: mated, engine }))).toBeNull();
    expect(engine.analyseCalls).toEqual([]);
  });

  it("refuses to move for the user", async () => {
    const afterE4 = playMoves("1.e4");
    await expect(chooseOpponentMove(context({ fen: afterE4[0].fenAfter, history: afterE4 }))).rejects.toThrow(/user's move/);
  });
});

describe("summariseSparring", () => {
  const tree = makeTree("black", [
    makeLine({ id: "advance", side: "black", moves: "1.e4 c6 2.d4 d5 3.e5 Bf5" }),
    makeLine({ id: "slav", side: "black", moves: "1.d4 d5 2.c4 c6 3.Nf3 Nf6" })
  ]);

  it("counts the plies in the repertoire and who left it first", () => {
    expect(summariseSparring(tree, OUT_OF_BOOK)).toEqual({
      inRepertoireThrough: 6,
      leftBy: "opponent",
      userDeviations: [],
      userMoves: 4,
      bookMoves: 3
    });
  });

  it("lists the user's deviations with the expected moves", () => {
    expect(summariseSparring(tree, playMoves("1.e4 c6 2.d4 e6 3.Nf3"))).toEqual({
      inRepertoireThrough: 3,
      leftBy: "user",
      userDeviations: [{ ply: 4, played: "e6", expected: ["d5"] }],
      userMoves: 2,
      bookMoves: 1
    });
  });

  it("catches a deviation after the game transposes back into the repertoire", () => {
    // 1.c4 c6 2.d4 d5 reaches the Slav position; 3.Nf3 is in the tree, 3...e6 is not the repertoire's 3...Nf6.
    expect(summariseSparring(tree, playMoves("1.c4 c6 2.d4 d5 3.Nf3 e6"))).toEqual({
      inRepertoireThrough: 0,
      leftBy: "opponent",
      userDeviations: [{ ply: 6, played: "e6", expected: ["Nf6"] }],
      userMoves: 3,
      bookMoves: 0
    });
  });

  it("a game that never leaves the repertoire", () => {
    const moves: AppliedMove[] = playMoves("1.d4 d5 2.c4 c6");
    expect(summariseSparring(tree, moves)).toEqual({ inRepertoireThrough: 4, leftBy: null, userDeviations: [], userMoves: 2, bookMoves: 2 });
    expect(summariseSparring(tree, [])).toEqual({ inRepertoireThrough: 0, leftBy: null, userDeviations: [], userMoves: 0, bookMoves: 0 });
  });
});

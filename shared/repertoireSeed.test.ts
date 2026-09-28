import { describe, expect, it } from "vitest";
import { START_EPD } from "./epd.js";
import { scoreWinPercent } from "./eval.js";
import { buildFixList } from "./fixList.js";
import type { EvalLookup } from "./openingAnalysis.js";
import { buildTree, type TreeGame } from "./openingTree.js";
import { replayOpening } from "./pgn.js";
import type { RepEntry } from "./repertoire.js";
import { SEED_FLAG_MIN_N, seedColor, seedDiff, seedFlags, type SeedFlag } from "./repertoireSeed.js";
import type { EngineLine, PlayerColor, PositionEval } from "./types.js";

const NOW = Date.parse("2026-09-27T00:00:00Z") / 1000;

let nextId = 1;
function game(line: string, color: PlayerColor, score: 0 | 0.5 | 1): TreeGame {
  const sans = line.split(" ");
  nextId += 1;
  return {
    id: String(nextId),
    endTime: NOW - 86_400 - nextId,
    color,
    score,
    myRating: 1200,
    oppRating: 1200,
    baseMs: 180_000,
    plyCount: 60,
    plies: replayOpening(sans, sans.length).map((ply) => ({ ...ply, spentMs: 1000 }))
  };
}

function results(line: string, color: PlayerColor, { wins = 0, losses = 0, draws = 0 }): TreeGame[] {
  return [
    ...Array.from({ length: wins }, () => game(line, color, 1)),
    ...Array.from({ length: losses }, () => game(line, color, 0)),
    ...Array.from({ length: draws }, () => game(line, color, 0.5))
  ];
}

const epdAfter = (line: string) => {
  if (!line) {
    return START_EPD;
  }
  const sans = line.split(" ");
  return replayOpening(sans, sans.length).at(-1)!.epdAfter;
};

const engineLine = (uci: string, cp: number): EngineLine => ({ uci, cp, mate: null, winPct: scoreWinPercent({ cp, mate: null }), depth: 15, pv: [uci] });

/** Owner-tier evals keyed by the SAN line to the position: [line, lines (best first), scored]. */
function lookupFrom(entries: [string, EngineLine[], EngineLine[]?][]): EvalLookup {
  const byEpd = new Map<string, PositionEval>();
  for (const [line, lines, scored = []] of entries) {
    const epd = epdAfter(line);
    byEpd.set(epd, { epd, tier: "owner", depth: 15, nodes: 1, lines, scored, terminal: null, bestUci: lines[0].uci, score: lines[0] });
  }
  return (epd) => byEpd.get(epd);
}

function seed(games: TreeGame[], color: PlayerColor, options: { lookup?: EvalLookup | null; flags?: Map<string, SeedFlag>; existing?: Map<string, RepEntry> } = {}) {
  const tree = buildTree(games, { color, now: NOW, halfLifeDays: null });
  const entries = seedColor({ tree, lookup: options.lookup ?? null, flags: options.flags ?? new Map(), existing: options.existing ?? new Map() });
  return { tree, entries, at: (line: string) => entries.find((entry) => entry.epd === epdAfter(line)) };
}

const entryOf = (fields: Partial<RepEntry> & Pick<RepEntry, "color" | "epd" | "uci" | "san">): RepEntry => ({
  source: "from-games",
  status: "active",
  locked: false,
  replaced: null,
  reason: null,
  note: null,
  ply: 1,
  updatedAt: 1,
  ...fields
});

// Black: 1.e4 e5 2.Nf3 with 2...Bc5 (an engine hole: -171 against 2...Nc6 -36) as the most-played move.
const ITALIAN = [
  ...results("e4 e5 Nf3 Bc5", "black", { wins: 5, losses: 5 }),
  ...results("e4 e5 Nf3 Nc6", "black", { wins: 2, losses: 2 })
];
const ITALIAN_EVALS = lookupFrom([["e4 e5 Nf3", [engineLine("b8c6", -36), engineLine("g8f6", -40), engineLine("d7d6", -60)], [engineLine("f8c5", -171)]]]);

// Black: 1.d4 d5 2.c4 with the Albin 2...e5 (engine-sound, loss ~4.3) scoring 30% over 20 games.
const ALBIN = [
  ...results("d4 d5 c4 e5", "black", { wins: 6, losses: 14 }),
  ...results("d4 d5 c4 e6", "black", { wins: 2, losses: 1 })
];
const ALBIN_EVALS = lookupFrom([["d4 d5 c4", [engineLine("e7e6", -31), engineLine("c7c6", -39), engineLine("d5c4", -38)], [engineLine("e7e5", -78)]]]);

describe("seedColor", () => {
  it("takes the most-played engine-sound move from the games", () => {
    const games = [...results("e4 e5 Nf3 Nc6", "black", { wins: 4, losses: 2 }), ...results("e4 e5 Nf3 Nf6", "black", { wins: 1, losses: 1 })];
    const lookup = lookupFrom([["e4 e5 Nf3", [engineLine("b8c6", -36), engineLine("g8f6", -40)]]]);
    const { at } = seed(games, "black", { lookup });
    expect(at("e4 e5 Nf3")).toMatchObject({ san: "Nc6", source: "from-games", status: "active", replaced: null, ply: 4 });
    // No engine data at 1.e4: chosen on results alone, marked for review.
    expect(at("e4")).toMatchObject({ san: "e5", source: "from-games", status: "needs-review" });
    expect(at("e4")!.reason).toContain("results only");
  });

  it("replaces an engine hole (2...Bc5) with the engine-sound move the owner also plays (2...Nc6)", () => {
    const { at } = seed(ITALIAN, "black", { lookup: ITALIAN_EVALS });
    const entry = at("e4 e5 Nf3")!;
    expect(entry).toMatchObject({ san: "Nc6", uci: "b8c6", source: "seed-engine", status: "needs-review" });
    expect(entry.replaced).toMatchObject({ san: "Bc5", uci: "f8c5" });
    expect(entry.replaced!.loss).toBeGreaterThan(10);
    expect(entry.replaced!.reason).toContain("engine hole");
  });

  it("falls back to the engine's best move when the owner plays no sound alternative", () => {
    const { at, entries } = seed(results("e4 e5 Nf3 Bc5", "black", { wins: 5, losses: 5 }), "black", { lookup: ITALIAN_EVALS });
    expect(at("e4 e5 Nf3")).toMatchObject({ san: "Nc6", source: "seed-engine", status: "needs-review", replaced: { san: "Bc5" } });
    expect(at("e4 e5 Nf3")!.reason).toContain("you have not played it");
    // The walk stops there: no games follow the engine's move.
    expect(entries.map((entry) => entry.ply)).toEqual([2, 4]);
  });

  it("keeps the Albin without a results flag (it is engine-sound)", () => {
    const { at } = seed(ALBIN, "black", { lookup: ALBIN_EVALS });
    expect(at("d4 d5 c4")).toMatchObject({ san: "e5", source: "from-games", status: "active" });
  });

  it("overrides a flagged results leak (the Albin) with an engine-sound sibling", () => {
    const fix = buildFixList([{ tree: buildTree(ALBIN, { color: "black", now: NOW, halfLifeDays: null }), games: ALBIN }]);
    const flags = seedFlags([...fix.items, ...fix.watch], "black");
    expect(flags.get(`${epdAfter("d4 d5 c4")}|e7e5`)).toMatchObject({ n: 20 });
    const { at } = seed(ALBIN, "black", { lookup: ALBIN_EVALS, flags });
    const entry = at("d4 d5 c4")!;
    expect(entry).toMatchObject({ san: "e6", source: "seed-engine", status: "needs-review", replaced: { san: "e5", uci: "e7e5" } });
    expect(["e6", "c6", "dxc4"]).toContain(entry.san);
    expect(entry.replaced!.loss).toBeCloseTo(ALBIN_EVALS(epdAfter("d4 d5 c4"), "owner")!.lines[0].winPct - scoreWinPercent({ cp: -78, mate: null }), 1);
    expect(entry.replaced!.reason).toMatch(/you score 30% over 20 games/);
    expect(entry.reason).toContain("you also play");
  });

  it("uses the engine's line for the override when the owner never played a sound sibling", () => {
    const games = results("d4 d5 c4 e5", "black", { wins: 6, losses: 14 });
    const flag: SeedFlag = { tier: "watch", n: 20, score: 0.3, expected: 0.5, z: 1.79, line: "1.d4 d5 2.c4 e5" };
    const { at } = seed(games, "black", { lookup: ALBIN_EVALS, flags: new Map([[`${epdAfter("d4 d5 c4")}|e7e5`, flag]]) });
    expect(at("d4 d5 c4")).toMatchObject({ san: "e6", source: "seed-engine", status: "needs-review", replaced: { san: "e5" } });
    expect(at("d4 d5 c4")!.replaced!.reason).toContain("Watch-tier");
  });

  it("ignores a results flag under SEED_FLAG_MIN_N games", () => {
    const flag: SeedFlag = { tier: "leak", n: SEED_FLAG_MIN_N - 1, score: 0.3, expected: 0.5, z: 2, line: "" };
    const { at } = seed(ALBIN, "black", { lookup: ALBIN_EVALS, flags: new Map([[`${epdAfter("d4 d5 c4")}|e7e5`, flag]]) });
    expect(at("d4 d5 c4")?.san).toBe("e5");
  });

  it("consolidates on a sibling that scores clearly better (z >= 1.64), marked for review", () => {
    const games = [...results("e4", "white", { wins: 12, losses: 18 }), ...results("d4", "white", { wins: 15, losses: 5 })];
    const { at } = seed(games, "white");
    const root = at("")!;
    expect(root).toMatchObject({ san: "d4", source: "from-games", status: "needs-review", replaced: { san: "e4" } });
    expect(root.replaced!.reason).toMatch(/z 2\.\d\d/);
  });

  it("does not consolidate on a sibling with fewer than 8 games", () => {
    const games = [...results("e4", "white", { wins: 12, losses: 18 }), ...results("d4", "white", { wins: 7 })];
    expect(seed(games, "white").at("")).toMatchObject({ san: "e4", source: "from-games", replaced: null });
  });

  it("marks a choice between two often-played moves (1...d5 next to 1...e5) for review", () => {
    const games = [...results("e4 d5", "black", { wins: 6, losses: 6 }), ...results("e4 e5", "black", { wins: 5, losses: 5 })];
    const lookup = lookupFrom([["e4", [engineLine("e7e5", -30), engineLine("d7d5", -60)]]]);
    const entry = seed(games, "black", { lookup }).at("e4")!;
    expect(entry).toMatchObject({ san: "d5", source: "from-games", status: "needs-review", replaced: { san: "e5" } });
    expect(entry.replaced!.reason).toContain("You play both");
  });

  it("needs 3 games at an owner position, and follows replies with 2+ games", () => {
    const games = [
      ...results("e4 e5 Nf3 Nc6 Bc4", "white", { wins: 3 }),
      ...results("e4 e5 Nf3 Nc6 Bb5", "white", { wins: 2 }),
      ...results("e4 c5 Nf3", "white", { wins: 2 }),
      game("e4 e6 d4", "white", 1)
    ];
    const { at } = seed(games, "white");
    expect(at("")?.san).toBe("e4");
    expect(at("e4 e5")?.san).toBe("Nf3");
    expect(at("e4 e5 Nf3 Nc6")?.san).toBe("Bc4");
    // 1...c5 (2 games) and 1...e6 (1 game, a 12% share) are followed, but their positions have fewer than 3 games.
    expect(at("e4 c5")).toBeUndefined();
    expect(at("e4 e6")).toBeUndefined();
  });

  it("gives transposed positions one entry", () => {
    const games = [
      ...results("d4 Nf6 c4 e6 Nc3", "white", { wins: 3 }),
      ...results("c4 e6 d4 Nf6 Nc3", "white", { wins: 1 }),
      ...results("d4 e6 c4 Nf6 Nc3", "white", { wins: 1 })
    ];
    const { entries } = seed(games, "white");
    const shared = entries.filter((entry) => entry.epd === epdAfter("d4 Nf6 c4 e6"));
    expect(shared).toHaveLength(1);
    expect(shared[0].san).toBe("Nc3");
    expect(new Set(entries.map((entry) => entry.epd)).size).toBe(entries.length);
  });

  it("gives byte-identical output for the same games in any order", () => {
    const games = [...ITALIAN, ...ALBIN, ...results("e4 d5 exd5 Qxd5 Nc3 Qa5", "black", { wins: 4, losses: 3, draws: 1 })];
    const first = JSON.stringify(seed(games, "black", { lookup: ITALIAN_EVALS }).entries);
    const shuffled = [...games].reverse();
    expect(JSON.stringify(seed(shuffled, "black", { lookup: ITALIAN_EVALS }).entries)).toBe(first);
    expect(JSON.stringify(seed(games, "black", { lookup: ITALIAN_EVALS }).entries)).toBe(first);
  });

  it("never overwrites locked or edited entries, and follows their move", () => {
    const epd = epdAfter("e4 e5 Nf3");
    const edited = entryOf({ color: "black", epd, uci: "f8c5", san: "Bc5", source: "edited", ply: 4, note: "I like it" });
    const lockedRoot = entryOf({ color: "black", epd: epdAfter("e4"), uci: "c7c5", san: "c5", locked: true, ply: 2 });
    const existing = new Map([
      [edited.epd, edited],
      [lockedRoot.epd, lockedRoot]
    ]);
    const games = [...ITALIAN, ...results("e4 e5 Nf3 Bc5 c3 Nf6", "black", { wins: 3 })];
    const { entries, at } = seed(games, "black", { lookup: ITALIAN_EVALS, existing });
    expect(at("e4")).toMatchObject({ san: "c5", kept: true });
    expect(at("e4 e5 Nf3")).toMatchObject({ san: "Bc5", source: "edited", kept: true });
    // The locked 1...c5 is followed, so 1.e4 e5 is not reached from the start and 2.Nf3's entry is only kept.
    expect(entries.filter((entry) => !entry.kept)).toEqual([]);

    const diff = seedDiff(existing, entries);
    expect(diff.kept).toBe(2);
    expect(diff.changes).toEqual([]);
  });

  it("diffs a re-seed: add, change, remove, update, and unchanged", () => {
    const { entries } = seed(ITALIAN, "black", { lookup: ITALIAN_EVALS });
    const empty = seedDiff(new Map(), entries);
    expect(empty.changes.map((change) => change.kind)).toEqual(["add", "add"]);

    const current = new Map<string, RepEntry>();
    for (const entry of entries) {
      const { kept: _kept, ...fields } = entry;
      current.set(entry.epd, entryOf(fields));
    }
    expect(seedDiff(current, entries)).toMatchObject({ changes: [], unchanged: 2, kept: 0 });

    const italian = epdAfter("e4 e5 Nf3");
    current.set(italian, { ...current.get(italian)!, uci: "g8f6", san: "Nf6" });
    const stray = entryOf({ color: "black", epd: epdAfter("d4"), uci: "d7d5", san: "d5", ply: 2 });
    current.set(stray.epd, stray);
    current.set(epdAfter("e4"), { ...current.get(epdAfter("e4"))!, reason: "old text" });
    const diff = seedDiff(current, entries);
    expect(diff.changes.map((change) => [change.kind, change.before?.san ?? null, change.after?.san ?? null])).toEqual([
      ["change", "Nf6", "Nc6"],
      ["remove", "d5", null],
      ["update", "e5", "e5"]
    ]);
  });
});

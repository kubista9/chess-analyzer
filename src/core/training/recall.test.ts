import { describe, expect, it } from "vitest";
import { toEpd } from "../chess/position";
import type { Line } from "../content/types";
import { seededRng } from "../util/random";
import { MIN_PLAN_OPTIONS, RECALL_PROMPTS, buildRecallQuestion, recallCandidates, type RecallKind, type RecallQuestion } from "./recall";
import { makeLine } from "./testing";

const ENGLISH = "English Opening";

const E5_FOUR_KNIGHTS = makeLine({
  id: "e5-four-knights",
  side: "white",
  chapterId: "eng-e5",
  family: ENGLISH,
  name: "Four Knights with g3",
  moves: "1.c4 e5 2.Nc3 Nf6 3.Nf3 Nc6 4.g3",
  order: 1,
  description: "Both sides develop their knights first.",
  plans: ["Fianchetto the bishop and play d4 when it works."]
});
const E5_CLOSED = makeLine({ id: "e5-closed", side: "white", chapterId: "eng-e5", family: ENGLISH, name: "Closed system", moves: "1.c4 e5 2.Nc3 Nc6 3.g3 g6 4.Bg2 Bg7 5.d3", order: 2 });
const E5_DRAGON = makeLine({ id: "e5-dragon", side: "white", chapterId: "eng-e5", family: ENGLISH, name: "Reversed Dragon", moves: "1.c4 e5 2.Nc3 Nf6 3.g3 d5 4.cxd5", order: 3 });
// Its recall position lies on E5_CLOSED's path: not a recall candidate, and E5_CLOSED is never its distractor.
const E5_SHORT = makeLine({ id: "e5-short", side: "white", chapterId: "eng-e5", family: ENGLISH, name: "Closed, early g3", moves: "1.c4 e5 2.Nc3 Nc6 3.g3", order: 4 });
const C5_SYMMETRICAL = makeLine({ id: "c5-symmetrical", side: "white", chapterId: "eng-c5", family: ENGLISH, name: "Symmetrical", moves: "1.c4 c5 2.Nc3 Nc6 3.g3", order: 10 });
// The same name as E5_CLOSED: offered at most once.
const C5_CLOSED = makeLine({ id: "c5-closed", side: "white", chapterId: "eng-c5", family: ENGLISH, name: "Closed system", moves: "1.c4 c5 2.g3", order: 11 });
const NF6_MIKENAS = makeLine({ id: "nf6-mikenas", side: "white", chapterId: "eng-nf6", family: ENGLISH, name: "Mikenas attack", moves: "1.c4 Nf6 2.Nc3 e6 3.e4", order: 20 });
const RETI = makeLine({ id: "reti-gambit", side: "white", chapterId: "reti", family: "Reti Opening", name: "Reti Gambit", moves: "1.Nf3 d5 2.c4", order: 30 });
const CARO = makeLine({ id: "caro-main", side: "black", chapterId: "caro", family: "Caro-Kann Defence", name: "Caro-Kann", moves: "1.e4 c6 2.d4 d5", order: 40 });
// A Black line through E5_FOUR_KNIGHTS's recall position.
const BLACK_FOUR_KNIGHTS = makeLine({
  id: "black-four-knights",
  side: "black",
  chapterId: "black-eng",
  family: ENGLISH,
  name: "Four Knights as Black",
  moves: "1.c4 e5 2.Nc3 Nf6 3.Nf3 Nc6 4.g3 Bb4",
  order: 41
});

const WHITE = [E5_FOUR_KNIGHTS, E5_CLOSED, E5_DRAGON, E5_SHORT, C5_SYMMETRICAL, C5_CLOSED, NF6_MIKENAS, RETI];
const POOL = [...WHITE, CARO, BLACK_FOUR_KNIGHTS];
const byId = new Map(POOL.map((line) => [line.id, line]));
const KINDS: RecallKind[] = ["opening", "plan"];

function question(line: Line, kind: RecallKind, seed = 7, pool: readonly Line[] = POOL): RecallQuestion | null {
  return buildRecallQuestion({ line, pool, kind, rng: seededRng(seed) });
}

function distractorIds(recall: RecallQuestion): string[] {
  return recall.options.map((option) => option.id).filter((id) => id !== recall.correctId);
}

describe("buildRecallQuestion: opening", () => {
  it("shows the line's recall position from the user's side", () => {
    const recall = question(E5_DRAGON, "opening")!;
    expect(recall).toMatchObject({
      id: "opening:e5-dragon",
      kind: "opening",
      lineId: "e5-dragon",
      fen: E5_DRAGON.finalFen,
      orientation: "white",
      movesShown: ["c4", "e5", "Nc3", "Nf6", "g3", "d5", "cxd5"],
      prompt: RECALL_PROMPTS.opening,
      correctId: "e5-dragon"
    });
    expect(recall.options.find((option) => option.id === recall.correctId)?.label).toBe("Reversed Dragon");
    expect(recall.explanation).toBe(`${E5_DRAGON.description} ${E5_DRAGON.plans[0]}`);
  });

  it("uses an earlier recall ply when the line sets one", () => {
    const line = makeLine({ id: "early", side: "white", chapterId: "eng-e5", family: ENGLISH, name: "Early", moves: "1.c4 e5 2.Nc3 Nf6 3.Nf3 d6 4.d4", recallPly: 6 });
    const recall = question(line, "opening")!;
    expect(recall.movesShown).toEqual(["c4", "e5", "Nc3", "Nf6", "Nf3", "d6"]);
    expect(recall.fen).toBe(line.moves[5].fenAfter);
    expect(recall.orientation).toBe("white");
  });

  it("prefers distractors from the same chapter", () => {
    const recall = question(E5_DRAGON, "opening")!;
    expect(recall.options).toHaveLength(4);
    expect(distractorIds(recall).sort()).toEqual(["e5-closed", "e5-four-knights", "e5-short"]);
  });

  it("then the same family, never another family while the family has enough, and each label once", () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const recall = question(C5_SYMMETRICAL, "opening", seed)!;
      const ids = distractorIds(recall);
      expect(ids).toHaveLength(3);
      expect(ids).toContain("c5-closed");
      expect(ids).not.toContain("reti-gambit");
      expect(ids.map((id) => byId.get(id)!.family)).toEqual([ENGLISH, ENGLISH, ENGLISH]);
      const labels = recall.options.map((option) => option.label);
      expect(new Set(labels).size).toBe(labels.length);
      // "Closed system" is already taken by c5-closed.
      expect(ids).not.toContain("e5-closed");
    }
  });

  it("falls back to any family of the same side, never the other side", () => {
    const recall = question(RETI, "opening", 3, [RETI, E5_DRAGON, CARO, BLACK_FOUR_KNIGHTS])!;
    expect(distractorIds(recall)).toEqual(["e5-dragon"]);
  });

  it("needs at least one valid distractor", () => {
    expect(question(RETI, "opening", 1, [RETI])).toBeNull();
    expect(question(RETI, "opening", 1, [RETI, CARO])).toBeNull();
    // A line through the shown position is no distractor.
    expect(question(E5_SHORT, "opening", 1, [E5_SHORT, E5_CLOSED])).toBeNull();
  });
});

describe("buildRecallQuestion: plan", () => {
  it("asks for the line's first plan against first plans of other chapters", () => {
    const recall = question(E5_FOUR_KNIGHTS, "plan")!;
    expect(recall).toMatchObject({ id: "plan:e5-four-knights", kind: "plan", prompt: RECALL_PROMPTS.plan, correctId: "e5-four-knights" });
    expect(recall.options.find((option) => option.id === recall.correctId)?.label).toBe(E5_FOUR_KNIGHTS.plans[0]);
    expect(recall.options).toHaveLength(4);
    for (const id of distractorIds(recall)) {
      const other = byId.get(id)!;
      expect(other.chapterId).not.toBe("eng-e5");
      expect(recall.options.find((option) => option.id === id)?.label).toBe(other.plans[0]);
    }
    expect(recall.explanation).toBe("Both sides develop their knights first. Fianchetto the bishop and play d4 when it works.");
  });

  it("prefers plans of the same side, then the other side", () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const ids = distractorIds(question(E5_DRAGON, "plan", seed)!);
      expect(ids.every((id) => byId.get(id)!.side === "white")).toBe(true);
    }
    const mixed = question(E5_DRAGON, "plan", 5, [E5_DRAGON, RETI, CARO, E5_CLOSED])!;
    expect(distractorIds(mixed).sort()).toEqual(["caro-main", "reti-gambit"]);
  });

  it("offers each plan once and needs at least MIN_PLAN_OPTIONS options", () => {
    expect(MIN_PLAN_OPTIONS).toBe(3);
    const samePlan = (line: Line, plan: string): Line => ({ ...line, plans: [plan] });
    const pool = [E5_DRAGON, samePlan(RETI, "Play in the centre."), samePlan(C5_CLOSED, "play in the centre. "), samePlan(NF6_MIKENAS, E5_DRAGON.plans[0])];
    // Two distinct texts at most (and one is the answer): too few.
    expect(question(E5_DRAGON, "plan", 1, pool)).toBeNull();
    const enough = question(E5_DRAGON, "plan", 1, [...pool, CARO])!;
    expect(enough.options).toHaveLength(3);
    const labels = enough.options.map((option) => option.label.trim().toLowerCase());
    expect(new Set(labels).size).toBe(3);
  });

  it("a line without a plan has no plan question", () => {
    expect(question({ ...E5_DRAGON, plans: [] }, "plan")).toBeNull();
  });
});

describe("question validity", () => {
  it("for every line, kind and seed: the answer appears once and no distractor passes through the shown position", () => {
    let built = 0;
    for (const line of POOL) {
      for (const kind of KINDS) {
        for (let seed = 0; seed < 20; seed += 1) {
          const recall = question(line, kind, seed);
          if (!recall) {
            continue;
          }
          built += 1;
          const epd = toEpd(recall.fen);
          expect(recall.options.filter((option) => option.id === recall.correctId)).toHaveLength(1);
          expect(new Set(recall.options.map((option) => option.id)).size).toBe(recall.options.length);
          expect(recall.options.length).toBeLessThanOrEqual(4);
          for (const id of distractorIds(recall)) {
            expect(byId.get(id)!.epds.includes(epd), `${id} passes through the position of ${line.id}`).toBe(false);
          }
        }
      }
    }
    expect(built).toBeGreaterThan(100);
  });

  it("is deterministic for a seed and shuffles the options", () => {
    expect(question(E5_DRAGON, "opening", 42)).toEqual(question(E5_DRAGON, "opening", 42));
    expect(question(E5_FOUR_KNIGHTS, "plan", 42)).toEqual(question(E5_FOUR_KNIGHTS, "plan", 42));
    const positions = new Set<number>();
    for (let seed = 0; seed < 30; seed += 1) {
      const recall = question(E5_DRAGON, "opening", seed)!;
      positions.add(recall.options.findIndex((option) => option.id === recall.correctId));
    }
    expect(positions.size).toBe(4);
  });

  it("does not depend on the order of the pool", () => {
    expect(question(C5_SYMMETRICAL, "opening", 9, [...POOL].reverse())).toEqual(question(C5_SYMMETRICAL, "opening", 9));
  });
});

describe("recallCandidates", () => {
  it("keeps lines whose recall position no other line of the same side reaches", () => {
    const ids = recallCandidates(POOL).map((line) => line.id);
    expect(ids).not.toContain("e5-short");
    expect(ids).toEqual(["e5-four-knights", "e5-closed", "e5-dragon", "c5-symmetrical", "c5-closed", "nf6-mikenas", "reti-gambit", "caro-main", "black-four-knights"]);
  });

  it("drops both lines when their recall positions are the same", () => {
    const transposed = makeLine({ id: "transposed", side: "white", moves: "1.Nf3 d5 2.c4" });
    const sameEnd = makeLine({ id: "same-end", side: "white", moves: "1.c4 d5 2.Nf3" });
    expect(toEpd(transposed.finalFen)).toBe(toEpd(sameEnd.finalFen));
    expect(recallCandidates([transposed, sameEnd, RETI]).map((line) => line.id)).toEqual([]);
    expect(recallCandidates([transposed, CARO]).map((line) => line.id)).toEqual(["transposed", "caro-main"]);
  });
});

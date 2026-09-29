import { describe, expect, it } from "vitest";
import { START_EPD } from "../epd.js";
import type { OpeningBook } from "../openingBook.js";
import { buildRepGraph } from "./cards.js";
import { planLineRuns, replyWeights, sampleLineRun, seededRng } from "./lineDrill.js";
import { entry, epdAfter, repertoire } from "../../test/trainingFixtures.js";

const black = repertoire([
  entry("black", ["e2e4"], "e7e5"),
  entry("black", ["e2e4", "e7e5", "g1f3"], "b8c6"),
  entry("black", ["e2e4", "e7e5", "b1c3"], "g8f6"),
  entry("black", ["d2d4"], "d7d5"),
  entry("black", ["d2d4", "d7d5", "c2c4"], "e7e6"),
  entry("black", ["c2c4"], "e7e5")
]);
const graph = buildRepGraph("black", black);

// The games' weighted reply counts: 1.e4 60, 1.d4 30, 1.c4 10, and 1.b3 (no entry) 50.
const weights: Record<string, Record<string, number>> = {
  [START_EPD]: { e2e4: 60, d2d4: 30, c2c4: 10, b2b3: 50 },
  [epdAfter(["e2e4", "e7e5"])]: { g1f3: 3, b1c3: 1 }
};
const replyWeight = (epd: string, uci: string) => weights[epd]?.[uci] ?? 0;

describe("line drill sampler", () => {
  it("matches the observed reply shares within ±10% over 200 seeded runs", () => {
    const counts: Record<string, number> = {};
    for (let seed = 1; seed <= 200; seed += 1) {
      const run = sampleLineRun(graph, { rng: seededRng(seed), replyWeight, graded: () => false });
      counts[run.steps[0].uci] = (counts[run.steps[0].uci] ?? 0) + 1;
    }
    // Among the prepared replies: 60/100, 30/100, 10/100 (1.b3 has no entry, so it is never played).
    expect(counts.b2b3).toBeUndefined();
    expect(Math.abs(counts.e2e4 / 200 - 0.6)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(counts.d2d4 / 200 - 0.3)).toBeLessThanOrEqual(0.1);
    expect(Math.abs((counts.c2c4 ?? 0) / 200 - 0.1)).toBeLessThanOrEqual(0.1);
  });

  it("never plays an unprepared reply and never asks for a move without an entry", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const run = sampleLineRun(graph, { rng: seededRng(seed), replyWeight, graded: () => true });
      for (const step of run.steps) {
        if (step.mover === "owner") {
          expect(black.get(step.epd)?.uci).toBe(step.uci);
          expect(step.graded).toBe(true);
        } else {
          const played = replyWeight(step.epd, step.uci) > 0;
          const prepared = [...black.values()].some((item) => item.epd === graph.moves.get(step.epd)!.find((move) => move.uci === step.uci)!.toEpd);
          expect(played || prepared).toBe(true);
          expect(prepared).toBe(true);
        }
      }
      expect(run.steps.length).toBeLessThanOrEqual(16);
      expect(run.steps.at(-1)!.mover).toBe("owner");
    }
  });

  it("is deterministic for a seed", () => {
    const one = sampleLineRun(graph, { rng: seededRng(7), replyWeight, graded: () => false });
    const two = sampleLineRun(graph, { rng: seededRng(7), replyWeight, graded: () => false });
    expect(one).toEqual(two);
  });

  it("falls back to the book's main reply without game data, else to a uniform choice", () => {
    const moves = graph.moves.get(START_EPD)!;
    const book = { children: new Map([[START_EPD, [{ san: "d4", uci: "d2d4", toEpd: epdAfter(["d2d4"]) }]]]) } as unknown as OpeningBook;
    const bookWeights = replyWeights(START_EPD, moves, { replyWeight: () => 0, book });
    expect(moves.filter((_move, index) => bookWeights[index] > 0).map((move) => move.uci)).toEqual(["d2d4"]);
    expect(replyWeights(START_EPD, moves, { replyWeight: () => 0 })).toEqual(moves.map(() => 1));
  });

  it("plans runs that cover every card to grade, preferring branches towards them", () => {
    const targets = new Set([epdAfter(["c2c4"]), epdAfter(["e2e4", "e7e5", "b1c3"]), epdAfter(["d2d4", "d7d5", "c2c4"])]);
    const runs = planLineRuns(graph, targets, { rng: seededRng(3), replyWeight });
    const graded = runs.flatMap((run) => run.steps.filter((step) => step.graded).map((step) => step.epd));
    expect(new Set(graded)).toEqual(targets);
    expect(graded).toHaveLength(targets.size);
    // Owner moves that are not due are auto-played (not graded).
    expect(runs.flatMap((run) => run.steps).some((step) => step.mover === "owner" && !step.graded)).toBe(true);
  });
});

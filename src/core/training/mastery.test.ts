import { describe, expect, it } from "vitest";
import { START_EPD } from "../chess/position";
import { linePositionKeys } from "../content/tree";
import { posKey } from "../content/types";
import { DAY_MS } from "../util/time";
import { newLadder, onWrongTry, requestHint, requestSolution } from "./hints";
import {
  MASTERED_AT,
  RECENT_RESULTS,
  REVIEWING_AT,
  WEAK_MOVES_KEPT,
  applyLineRun,
  applyPositionResult,
  applyRecallAnswer,
  effectiveStatus,
  lineMastery,
  newLineProgress,
  newPositionProgress,
  positionMastery,
  suggestedStatus
} from "./mastery";
import { fuzzFactor, newSrs } from "./scheduler";
import { makeLine, makeProgress } from "./testing";
import type { LadderState, LineState, PositionProgress, Result } from "./types";

const NOW = Date.UTC(2026, 9, 1, 12);
const EPD = "rnbqkbnr/pppp1ppp/8/4p3/2P5/8/PP1PPPPP/RNBQKBNR w KQkq -";

const CLEAN = newLadder();
const HINTED = requestHint(newLadder());
const RETRIED = onWrongTry(newLadder(), 3);
const TWICE_WRONG = onWrongTry(RETRIED, 3);
const REVEALED = requestSolution(newLadder());

function answer(progress: PositionProgress, ladder: LadderState, now: number, wrongSans: string[] = []): PositionProgress {
  return applyPositionResult(progress, { ladder, wrongSans, now });
}

describe("position progress", () => {
  it("starts empty under its position key", () => {
    expect(newPositionProgress("white", EPD)).toEqual({
      key: posKey("white", EPD),
      side: "white",
      epd: EPD,
      attempts: 0,
      clean: 0,
      incorrect: 0,
      wrongTries: 0,
      hintsUsed: 0,
      reveals: 0,
      firstSeenAt: null,
      lastPracticedAt: null,
      lastResult: null,
      recent: [],
      mastery: 0,
      srs: newSrs(),
      weakMoves: []
    });
  });

  it("a clean answer counts, schedules good and sets the mastery", () => {
    const progress = answer(newPositionProgress("white", EPD), CLEAN, NOW);
    expect(progress).toMatchObject({
      attempts: 1,
      clean: 1,
      incorrect: 0,
      wrongTries: 0,
      hintsUsed: 0,
      reveals: 0,
      firstSeenAt: NOW,
      lastPracticedAt: NOW,
      lastResult: "clean",
      recent: ["clean"],
      weakMoves: []
    });
    expect(progress.srs).toMatchObject({ box: 2, introducedAt: NOW, reviews: 1, streak: 1, lapses: 0 });
    expect(progress.srs.dueAt).toBe(NOW + Math.round(DAY_MS * fuzzFactor(progress.key, 1)));
    expect(progress.mastery).toBeCloseTo(0.6 + 0.4 * (2 / 6), 12);
    expect(progress.mastery).toBe(positionMastery(progress));
  });

  it("a wrong try counts as incorrect, adds its hint and schedules hard; the first sighting is kept", () => {
    const first = answer(newPositionProgress("white", EPD), CLEAN, NOW);
    const later = NOW + 2 * DAY_MS;
    const second = answer(first, RETRIED, later, ["Nf3"]);
    expect(second).toMatchObject({
      attempts: 2,
      clean: 1,
      incorrect: 1,
      wrongTries: 1,
      hintsUsed: 1,
      reveals: 0,
      firstSeenAt: NOW,
      lastPracticedAt: later,
      lastResult: "retried",
      recent: ["clean", "retried"],
      weakMoves: [{ san: "Nf3", count: 1, lastAt: later }]
    });
    expect(second.srs).toMatchObject({ box: 2, streak: 0, lapses: 0 });
    // EMA oldest first: 1, then 0.5 * 0.4 + 0.5 * 1 = 0.7.
    expect(second.mastery).toBeCloseTo(0.6 * 0.7 + 0.4 * (2 / 6), 12);
  });

  it("a reveal lapses the schedule and counts the reveal and the hints shown", () => {
    const revealedAfterTries = onWrongTry(TWICE_WRONG, 3);
    const progress = answer(newPositionProgress("black", EPD), revealedAfterTries, NOW, ["a6", "h6", "a6"]);
    expect(progress).toMatchObject({ incorrect: 1, wrongTries: 3, hintsUsed: 2, reveals: 1, lastResult: "revealed" });
    expect(progress.srs).toMatchObject({ box: 1, lapses: 1, dueAt: NOW + DAY_MS });
    expect(progress.weakMoves).toEqual([
      { san: "a6", count: 2, lastAt: NOW },
      { san: "h6", count: 1, lastAt: NOW }
    ]);
    // Result 0 and box 1: 0.4 * 1 / 6.
    expect(progress.mastery).toBeCloseTo(0.4 / 6, 12);
  });

  it("keeps the last RECENT_RESULTS results, newest last", () => {
    const results: [LadderState, Result][] = [
      [CLEAN, "clean"],
      [HINTED, "hinted"],
      [RETRIED, "retried"],
      [REVEALED, "revealed"]
    ];
    let progress = newPositionProgress("white", EPD);
    const played: Result[] = [];
    for (let index = 0; index < 11; index += 1) {
      const [ladder, result] = results[index % results.length];
      progress = answer(progress, ladder, NOW + index * DAY_MS);
      played.push(result);
    }
    expect(RECENT_RESULTS).toBe(8);
    expect(progress.recent).toEqual(played.slice(-8));
    expect(progress.attempts).toBe(11);
  });

  it("merges weak moves: most frequent first, then most recent, then SAN; at most WEAK_MOVES_KEPT", () => {
    let progress = newPositionProgress("white", EPD);
    progress = answer(progress, RETRIED, NOW, ["Nf3"]);
    progress = answer(progress, RETRIED, NOW + DAY_MS, ["g3"]);
    progress = answer(progress, RETRIED, NOW + 2 * DAY_MS, ["Nf3"]);
    progress = answer(progress, RETRIED, NOW + 3 * DAY_MS, ["d4", "b3"]);
    expect(progress.weakMoves).toEqual([
      { san: "Nf3", count: 2, lastAt: NOW + 2 * DAY_MS },
      { san: "b3", count: 1, lastAt: NOW + 3 * DAY_MS },
      { san: "d4", count: 1, lastAt: NOW + 3 * DAY_MS },
      { san: "g3", count: 1, lastAt: NOW + DAY_MS }
    ]);
    progress = answer(progress, TWICE_WRONG, NOW + 4 * DAY_MS, ["e3", "a3", ""]);
    expect(WEAK_MOVES_KEPT).toBe(5);
    expect(progress.weakMoves.map((move) => move.san)).toEqual(["Nf3", "a3", "e3", "b3", "d4"]);
  });

  it("does not mutate the stored progress", () => {
    const first = answer(newPositionProgress("white", EPD), RETRIED, NOW, ["Nf3"]);
    const snapshot = structuredClone(first);
    answer(first, RETRIED, NOW + DAY_MS, ["Nf3", "g3"]);
    expect(first).toEqual(snapshot);
  });
});

describe("positionMastery", () => {
  it("is 0 before the first attempt", () => {
    expect(positionMastery(newPositionProgress("white", EPD))).toBe(0);
    expect(positionMastery(makeProgress("white", EPD, { srs: { ...newSrs(), box: 6 } }))).toBe(0);
  });

  it("weighs recent results more than old ones (EMA α 0.5, oldest first)", () => {
    const srs = { ...newSrs(), box: 3 };
    const improving = makeProgress("white", EPD, { attempts: 3, recent: ["revealed", "revealed", "clean"], srs });
    const worsening = makeProgress("white", EPD, { attempts: 3, recent: ["clean", "revealed", "revealed"], srs });
    expect(positionMastery(improving)).toBeCloseTo(0.6 * 0.5 + 0.4 * 0.5, 12);
    expect(positionMastery(worsening)).toBeCloseTo(0.6 * 0.25 + 0.4 * 0.5, 12);
  });

  it("reaches 1 with clean results in the last box and stays within 0..1", () => {
    expect(positionMastery(makeProgress("white", EPD, { attempts: 8, recent: Array(8).fill("clean"), srs: { ...newSrs(), box: 6 } }))).toBe(1);
    expect(positionMastery(makeProgress("white", EPD, { attempts: 1, recent: ["clean"], srs: { ...newSrs(), box: 99 } }))).toBe(1);
    expect(positionMastery(makeProgress("white", EPD, { attempts: 1, recent: [], srs: { ...newSrs(), box: -2 } }))).toBe(0);
  });

  it("a position is mastered after three clean reviews in a row", () => {
    let progress = newPositionProgress("white", EPD);
    const masteries: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      progress = answer(progress, CLEAN, progress.srs.dueAt ?? NOW);
      masteries.push(progress.mastery);
    }
    expect(masteries.map((mastery) => mastery >= MASTERED_AT)).toEqual([false, false, true, true]);
  });
});

describe("line progress", () => {
  it("starts empty", () => {
    expect(newLineProgress("eng-main")).toEqual({
      lineId: "eng-main",
      runs: 0,
      cleanRuns: 0,
      movesPlayed: 0,
      movesClean: 0,
      wrongTries: 0,
      hintsUsed: 0,
      reveals: 0,
      recallAttempts: 0,
      recallCorrect: 0,
      lastPracticedAt: null,
      lastResult: null,
      srs: newSrs()
    });
  });

  it("a clean run counts as clean and schedules good", () => {
    const progress = applyLineRun(newLineProgress("eng-main"), { ladders: [CLEAN, CLEAN, CLEAN], now: NOW });
    expect(progress).toMatchObject({ runs: 1, cleanRuns: 1, movesPlayed: 3, movesClean: 3, lastResult: "clean", lastPracticedAt: NOW });
    expect(progress.srs).toMatchObject({ box: 2, introducedAt: NOW, streak: 1 });
  });

  it("a run is graded by its worst move", () => {
    const hinted = applyLineRun(newLineProgress("eng-main"), { ladders: [CLEAN, HINTED, CLEAN], now: NOW });
    expect(hinted).toMatchObject({ runs: 1, cleanRuns: 0, movesPlayed: 3, movesClean: 2, hintsUsed: 1, lastResult: "hinted" });
    expect(hinted.srs).toMatchObject({ box: 1, lapses: 0, streak: 0 });

    const mixed = applyLineRun(hinted, { ladders: [RETRIED, REVEALED, HINTED, CLEAN], now: NOW + DAY_MS });
    expect(mixed).toMatchObject({
      runs: 2,
      cleanRuns: 0,
      movesPlayed: 7,
      movesClean: 3,
      wrongTries: 1,
      hintsUsed: 1 + 1 + 2 + 1,
      reveals: 1,
      lastResult: "revealed",
      lastPracticedAt: NOW + DAY_MS
    });
    expect(mixed.srs).toMatchObject({ box: 1, lapses: 1 });

    const twoHints = applyLineRun(newLineProgress("x"), { ladders: [CLEAN, requestHint(HINTED)], now: NOW });
    expect(twoHints.lastResult).toBe("hinted");
    expect(twoHints.srs.lapses).toBe(1);
  });

  it("a run without user moves changes nothing", () => {
    const progress = newLineProgress("eng-main");
    expect(applyLineRun(progress, { ladders: [], now: NOW })).toBe(progress);
  });

  it("a recall answer counts towards recall only and leaves the line's schedule alone", () => {
    const run = applyLineRun(newLineProgress("eng-main"), { ladders: [CLEAN], now: NOW });
    const wrong = applyRecallAnswer(run, { correct: false, now: NOW + DAY_MS });
    expect(wrong).toMatchObject({ recallAttempts: 1, recallCorrect: 0, lastPracticedAt: NOW + DAY_MS, runs: 1, lastResult: "clean" });
    expect(wrong.srs).toEqual(run.srs);
    const right = applyRecallAnswer(wrong, { correct: true, now: NOW + 2 * DAY_MS });
    expect(right).toMatchObject({ recallAttempts: 2, recallCorrect: 1 });
  });
});

describe("line mastery and status", () => {
  const line = makeLine({ id: "eng-main", side: "white", moves: "1.c4 e5 2.Nc3 Nc6 3.g3" });
  const keys = linePositionKeys(line);

  it("averages the line's user positions, unseen ones counting 0", () => {
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(posKey("white", START_EPD));
    const positions = new Map<string, PositionProgress>([
      [keys[0], makeProgress("white", line.epds[0], { attempts: 2, mastery: 0.9 })],
      [keys[1], makeProgress("white", line.epds[2], { attempts: 1, mastery: 0.6 })],
      // Stored but never attempted: unseen.
      [keys[2], makeProgress("white", line.epds[4], { attempts: 0, mastery: 0.7 })]
    ]);
    const result = lineMastery(line, positions);
    expect(result.seen).toBe(2);
    expect(result.total).toBe(3);
    expect(result.mastery).toBeCloseTo(1.5 / 3, 12);
    expect(lineMastery(line, new Map())).toEqual({ mastery: 0, seen: 0, total: 3 });
  });

  it("a line without user moves has nothing to master", () => {
    const empty = makeLine({ id: "empty", side: "black", moves: "1.e4" });
    expect(lineMastery(empty, new Map())).toEqual({ mastery: 0, seen: 0, total: 0 });
    expect(suggestedStatus(0, 0, 0)).toBe("learning");
  });

  it("suggests a status at the exact thresholds", () => {
    expect(MASTERED_AT).toBe(0.85);
    expect(REVIEWING_AT).toBe(0.4);
    expect(suggestedStatus(0.85, 3, 3)).toBe("mastered");
    expect(suggestedStatus(1, 3, 3)).toBe("mastered");
    expect(suggestedStatus(0.8499, 3, 3)).toBe("reviewing");
    // Mastered needs every position seen.
    expect(suggestedStatus(0.9, 2, 3)).toBe("reviewing");
    expect(suggestedStatus(0.4, 1, 3)).toBe("reviewing");
    expect(suggestedStatus(0.3999, 3, 3)).toBe("learning");
    expect(suggestedStatus(0, 0, 3)).toBe("learning");
  });

  it("a status set by hand wins over the suggestion", () => {
    const followed: LineState = { lineId: "eng-main", enabled: true, status: "mastered", statusSetAt: null, updatedAt: NOW };
    const manual: LineState = { ...followed, statusSetAt: NOW };
    expect(effectiveStatus(undefined, "learning")).toBe("learning");
    expect(effectiveStatus(followed, "learning")).toBe("learning");
    expect(effectiveStatus(manual, "learning")).toBe("mastered");
    expect(effectiveStatus({ ...manual, statusSetAt: 0 }, "reviewing")).toBe("mastered");
  });
});

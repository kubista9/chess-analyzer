import { describe, expect, it } from "vitest";
import { DAY_MS } from "../util/time";
import { BOX_DAYS, FUZZ, LAPSE_DAYS, LAST_BOX, fuzzFactor, grade, intervalDays, isDue, isNew, newSrs, overdueRatio } from "./scheduler";
import type { SrsState } from "./types";

const NOW = Date.UTC(2026, 9, 1, 12);
const ID = "white|rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq -";

/** Days from `from` to the state's due time. */
const daysUntilDue = (state: SrsState, from: number): number => (state.dueAt! - from) / DAY_MS;

/** A state graded good `times` times in a row, each answer given exactly when it fell due. */
function goodTimes(times: number, id = ID): { state: SrsState; at: number } {
  let state = newSrs();
  let at = NOW;
  for (let step = 0; step < times; step += 1) {
    state = grade(id, state, "good", at);
    if (step < times - 1) {
      at = state.dueAt!;
    }
  }
  return { state, at };
}

describe("newSrs, isNew and isDue", () => {
  it("a new item is in box 0, not due and new", () => {
    const state = newSrs();
    expect(state).toEqual({ box: 0, dueAt: null, introducedAt: null, lapses: 0, streak: 0, reviews: 0, lastReviewAt: null });
    expect(isNew(state)).toBe(true);
    expect(isDue(state, NOW)).toBe(false);
    expect(isDue(state, NOW + 1000 * DAY_MS)).toBe(false);
  });

  it("is due exactly from its due time on", () => {
    const state = grade(ID, newSrs(), "again", NOW);
    expect(isNew(state)).toBe(false);
    expect(isDue(state, state.dueAt! - 1)).toBe(false);
    expect(isDue(state, state.dueAt!)).toBe(true);
    expect(isDue(state, state.dueAt! + DAY_MS)).toBe(true);
  });

  it("a box above 0 without a due time is not due", () => {
    expect(isDue({ ...newSrs(), box: 2 }, NOW)).toBe(false);
  });
});

describe("intervals and fuzz", () => {
  it("BOX_DAYS are the intervals after a good answer in each box, clamped to the boxes", () => {
    expect(BOX_DAYS).toEqual([1, 3, 7, 16, 35, 60]);
    expect(LAST_BOX).toBe(6);
    expect(BOX_DAYS.map((_, index) => intervalDays(index + 1))).toEqual([1, 3, 7, 16, 35, 60]);
    expect(intervalDays(0)).toBe(1);
    expect(intervalDays(-3)).toBe(1);
    expect(intervalDays(7)).toBe(60);
    expect(intervalDays(Number.NaN)).toBe(1);
  });

  it("fuzz is deterministic per id and box and stays within ±5%", () => {
    expect(FUZZ).toBe(0.05);
    expect(fuzzFactor(ID, 2)).toBe(fuzzFactor(ID, 2));
    expect(fuzzFactor(ID, 2)).not.toBe(fuzzFactor(ID, 3));
    expect(fuzzFactor("a", 1)).not.toBe(fuzzFactor("b", 1));
    let below = 0;
    let above = 0;
    for (let index = 0; index < 500; index += 1) {
      const factor = fuzzFactor(`item-${index}`, (index % 6) + 1);
      expect(factor).toBeGreaterThanOrEqual(1 - FUZZ);
      expect(factor).toBeLessThanOrEqual(1 + FUZZ);
      if (factor < 1) {
        below += 1;
      } else {
        above += 1;
      }
    }
    // Spread on both sides of 1, not a constant.
    expect(below).toBeGreaterThan(100);
    expect(above).toBeGreaterThan(100);
  });
});

describe("grade", () => {
  it("a first answer introduces the item into box 1 at that time", () => {
    for (const outcome of ["good", "hard", "again"] as const) {
      const state = grade(ID, newSrs(), outcome, NOW);
      expect(state.introducedAt).toBe(NOW);
      expect(state.reviews).toBe(1);
      expect(state.lastReviewAt).toBe(NOW);
    }
    expect(grade(ID, newSrs(), "good", NOW).box).toBe(2);
    expect(grade(ID, newSrs(), "hard", NOW).box).toBe(1);
    expect(grade(ID, newSrs(), "again", NOW).box).toBe(1);
  });

  it("good answers climb the boxes 1, 3, 7, 16, 35, 60 days (±5% fuzz); the last box repeats 60", () => {
    let state = newSrs();
    let at = NOW;
    const intervals: number[] = [];
    const boxes: number[] = [];
    for (let step = 0; step < 8; step += 1) {
      const before = state.box === 0 ? 1 : state.box;
      state = grade(ID, state, "good", at);
      const days = daysUntilDue(state, at);
      intervals.push(days);
      boxes.push(state.box);
      expect(days).toBeCloseTo(intervalDays(before) * fuzzFactor(ID, before), 6);
      at = state.dueAt!;
    }
    const nominal = [1, 3, 7, 16, 35, 60, 60, 60];
    intervals.forEach((days, index) => {
      expect(days).toBeGreaterThanOrEqual(nominal[index] * (1 - FUZZ) - 1e-9);
      expect(days).toBeLessThanOrEqual(nominal[index] * (1 + FUZZ) + 1e-9);
    });
    expect(boxes).toEqual([2, 3, 4, 5, 6, 6, 6, 6]);
    expect(state.streak).toBe(8);
    expect(state.reviews).toBe(8);
    expect(state.introducedAt).toBe(NOW);
    expect(state.lapses).toBe(0);
  });

  it("due times are whole milliseconds", () => {
    const { state } = goodTimes(5);
    expect(Number.isInteger(state.dueAt)).toBe(true);
  });

  it("hard keeps the box, waits half the interval (at least a day, fuzzed) and resets the streak", () => {
    // Box 1: max(1, 1 / 2) = 1 day.
    const box1 = grade(ID, newSrs(), "hard", NOW);
    expect(box1).toMatchObject({ box: 1, streak: 0, lapses: 0 });
    expect(daysUntilDue(box1, NOW)).toBeCloseTo(1 * fuzzFactor(ID, 1), 6);

    // Box 2: max(1, 3 / 2) = 1.5 days.
    const { state: inBox2, at } = goodTimes(1);
    expect(inBox2.box).toBe(2);
    const later = inBox2.dueAt!;
    const hard2 = grade(ID, inBox2, "hard", later);
    expect(hard2).toMatchObject({ box: 2, streak: 0, reviews: 2, lastReviewAt: later });
    expect(daysUntilDue(hard2, later)).toBeCloseTo(1.5 * fuzzFactor(ID, 2), 6);
    expect(at).toBe(NOW);

    // The last box: 60 / 2 = 30 days.
    const { state: inLast } = goodTimes(6);
    expect(inLast.box).toBe(6);
    const hardLast = grade(ID, inLast, "hard", inLast.dueAt!);
    expect(hardLast.box).toBe(6);
    expect(daysUntilDue(hardLast, inLast.dueAt!)).toBeCloseTo(30 * fuzzFactor(ID, 6), 6);
  });

  it("again sends the item back to box 1, due after LAPSE_DAYS (no fuzz), with a lapse", () => {
    const { state: high } = goodTimes(4);
    expect(high.box).toBe(5);
    const at = high.dueAt! + 3 * DAY_MS;
    const lapsed = grade(ID, high, "again", at);
    expect(lapsed).toMatchObject({ box: 1, dueAt: at + LAPSE_DAYS * DAY_MS, lapses: 1, streak: 0, reviews: 5, lastReviewAt: at });
    expect(lapsed.introducedAt).toBe(NOW);
    const again = grade(ID, lapsed, "again", lapsed.dueAt!);
    expect(again.lapses).toBe(2);
    expect(again.box).toBe(1);
  });

  it("after a lapse the item climbs again from box 1", () => {
    const lapsed = grade(ID, goodTimes(3).state, "again", NOW + 30 * DAY_MS);
    const good = grade(ID, lapsed, "good", lapsed.dueAt!);
    expect(good.box).toBe(2);
    expect(good.streak).toBe(1);
    expect(daysUntilDue(good, lapsed.dueAt!)).toBeCloseTo(fuzzFactor(ID, 1), 6);
  });

  it("does not mutate its input", () => {
    const state = newSrs();
    const copy = { ...state };
    grade(ID, state, "good", NOW);
    expect(state).toEqual(copy);
  });

  it("repairs an out-of-range box", () => {
    const state = grade(ID, { ...newSrs(), box: 9, dueAt: NOW, introducedAt: NOW }, "good", NOW);
    expect(state.box).toBe(6);
    expect(daysUntilDue(state, NOW)).toBeCloseTo(60 * fuzzFactor(ID, 6), 6);
  });
});

describe("overdueRatio", () => {
  it("is 0 for new items and before the due time", () => {
    expect(overdueRatio(newSrs(), NOW)).toBe(0);
    const state = grade(ID, newSrs(), "good", NOW);
    expect(overdueRatio(state, NOW)).toBe(0);
    expect(overdueRatio(state, state.dueAt!)).toBe(0);
    expect(overdueRatio(state, state.dueAt! - DAY_MS)).toBe(0);
  });

  it("counts lateness in units of the interval the item is on", () => {
    // Box 2 after one good answer: the interval is 1 day (fuzzed).
    const state = grade(ID, newSrs(), "good", NOW);
    const interval = state.dueAt! - NOW;
    expect(overdueRatio(state, state.dueAt! + interval)).toBeCloseTo(1, 9);
    expect(overdueRatio(state, state.dueAt! + interval / 2)).toBeCloseTo(0.5, 9);

    // After a lapse the interval is LAPSE_DAYS.
    const lapsed = grade(ID, goodTimes(4).state, "again", NOW + 100 * DAY_MS);
    expect(overdueRatio(lapsed, lapsed.dueAt! + 2 * DAY_MS)).toBeCloseTo(2, 9);

    // After a hard answer in box 3 (7 / 2 = 3.5 days).
    const box3 = goodTimes(2).state;
    const hard = grade(ID, box3, "hard", box3.dueAt!);
    expect(overdueRatio(hard, hard.dueAt! + 3.5 * fuzzFactor(ID, 3) * DAY_MS)).toBeCloseTo(1, 6);
  });

  it("uses the last box's own 60 days, not the previous box's 35", () => {
    // Good from box 5 (35 days) puts the item into box 6.
    const fromBox5 = goodTimes(5).state;
    expect(fromBox5.box).toBe(6);
    const interval5 = fromBox5.dueAt! - fromBox5.lastReviewAt!;
    expect(interval5 / DAY_MS).toBeCloseTo(35 * fuzzFactor(ID, 5), 6);
    expect(overdueRatio(fromBox5, fromBox5.dueAt! + interval5)).toBeCloseTo(1, 9);

    // Good in box 6 keeps it there on a 60-day interval.
    const inLast = goodTimes(6).state;
    expect(inLast.box).toBe(6);
    const interval6 = inLast.dueAt! - inLast.lastReviewAt!;
    expect(interval6 / DAY_MS).toBeCloseTo(60 * fuzzFactor(ID, 6), 6);
    const late = inLast.dueAt! + 30 * DAY_MS;
    expect(overdueRatio(inLast, late)).toBeCloseTo((30 * DAY_MS) / interval6, 9);
    expect(overdueRatio(inLast, late)).toBeLessThan(30 / 35);
  });

  it("falls back to the nominal interval into the box when no review is on record", () => {
    const imported: SrsState = { ...newSrs(), box: 3, dueAt: NOW, introducedAt: NOW - 10 * DAY_MS };
    // Box 3 is reached by a good answer in box 2: 3 days.
    expect(overdueRatio(imported, NOW + 3 * DAY_MS)).toBeCloseTo(1, 9);
    const box1: SrsState = { ...newSrs(), box: 1, dueAt: NOW };
    expect(overdueRatio(box1, NOW + 2 * DAY_MS)).toBeCloseTo(2, 9);
  });
});

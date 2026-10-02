import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  SCHEDULES,
  fuzzFactor,
  grade,
  introduce,
  isDue,
  newSlots,
  newState,
  resetForRecurrence,
  sessionPriority,
  startOfDay
} from "./scheduler";

const NOW = Date.UTC(2026, 8, 26, 10, 0, 0);
const ID = "own-mistake|black|rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -";

describe("Leitner scheduler", () => {
  it("introduces a new card into box 1, due now", () => {
    const state = introduce(newState(), NOW);
    expect(state).toMatchObject({ box: 1, dueAt: NOW, introducedAt: NOW });
    expect(isDue(state, NOW)).toBe(true);
    expect(isDue(newState(), NOW)).toBe(false);
  });

  it("moves a line card up the boxes 1, 3, 7, 16, 35, 60 days with ±5% fuzz", () => {
    let state = introduce(newState(), NOW);
    let now = NOW;
    const days: number[] = [];
    for (let step = 0; step < 7; step += 1) {
      state = grade("repertoire-line", "line-id", state, "correct", now);
      days.push((state.dueAt! - now) / DAY_MS);
      now = state.dueAt!;
    }
    const expected = [1, 3, 7, 16, 35, 60, 60];
    days.forEach((value, index) => {
      expect(value).toBeGreaterThanOrEqual(expected[index] * 0.95 - 1e-6);
      expect(value).toBeLessThanOrEqual(expected[index] * 1.05 + 1e-6);
    });
    expect(state.box).toBe(SCHEDULES["repertoire-line"].boxesDays.length);
    expect(state.retired).toBe(false);
  });

  it("fuzz is deterministic and within ±5%", () => {
    expect(fuzzFactor(ID, 2)).toBe(fuzzFactor(ID, 2));
    for (let box = 1; box < 50; box += 1) {
      const factor = fuzzFactor(`card-${box}`, box);
      expect(factor).toBeGreaterThanOrEqual(0.95);
      expect(factor).toBeLessThanOrEqual(1.05);
    }
  });

  it("a wrong answer sends the card to box 1, due tomorrow, with a lapse", () => {
    let state = introduce(newState(), NOW);
    state = grade("own-mistake", ID, state, "correct", NOW);
    state = grade("own-mistake", ID, state, "correct", state.dueAt!);
    const at = state.dueAt!;
    const wrong = grade("own-mistake", ID, state, "wrong", at);
    expect(wrong).toMatchObject({ box: 1, dueAt: at + DAY_MS, lapses: 1, streak: 0, reviews: 3 });
    expect(isDue(wrong, at + DAY_MS - 1)).toBe(false);
    expect(isDue(wrong, at + DAY_MS)).toBe(true);
  });

  it("grading a new card introduces it first", () => {
    const state = grade("repertoire-line", "x", newState(), "wrong", NOW);
    expect(state).toMatchObject({ box: 1, introducedAt: NOW, lapses: 1 });
  });

  it("retires a mistake card after 3 correct in a row once the interval reaches 21 days", () => {
    let state = introduce(newState(), NOW);
    const steps: { days: number; retired: boolean }[] = [];
    let now = NOW;
    for (let step = 0; step < 4; step += 1) {
      state = grade("own-mistake", ID, state, "correct", now);
      steps.push({ days: Math.round((state.dueAt! - now) / DAY_MS), retired: state.retired });
      now = state.dueAt!;
    }
    // 2, 5, 14 days: streak 3 but 14 < 21; the 4th (30 days) retires it.
    expect(steps.map((step) => step.retired)).toEqual([false, false, false, true]);
    expect(isDue(state, now + 365 * DAY_MS)).toBe(false);
  });

  it("a recurrence brings a retired card back, due now, with a lapse", () => {
    let state = introduce(newState(), NOW);
    for (let step = 0; step < 4; step += 1) {
      state = grade("own-mistake", ID, state, "correct", state.dueAt!);
    }
    expect(state.retired).toBe(true);
    const later = NOW + 100 * DAY_MS;
    const back = resetForRecurrence(state, later);
    expect(back).toMatchObject({ retired: false, box: 1, dueAt: later, lapses: 1, streak: 0 });
    expect(isDue(back, later)).toBe(true);
  });

  it("orders a session by overdue ratio times weight", () => {
    const due = introduce(newState(), NOW);
    const overdue = { ...grade("repertoire-line", "a", due, "correct", NOW - 3 * DAY_MS) }; // due 2 days ago (1-day box)
    expect(sessionPriority("repertoire-line", due, 2, NOW)).toBe(2);
    expect(sessionPriority("repertoire-line", overdue, 2, NOW)).toBeGreaterThan(4);
    expect(sessionPriority("repertoire-line", newState(), 3, NOW)).toBe(3);
  });

  it("caps new cards per day and kind", () => {
    expect(newSlots("own-mistake", 0)).toBe(5);
    expect(newSlots("own-mistake", 4)).toBe(1);
    expect(newSlots("repertoire-line", 9)).toBe(0);
    const day = startOfDay(NOW);
    expect(day).toBeLessThanOrEqual(NOW);
    expect(NOW - day).toBeLessThan(DAY_MS);
  });
});

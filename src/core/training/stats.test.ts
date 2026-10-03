import { describe, expect, it } from "vitest";
import { DAY_MS, dayKey } from "../util/time";
import { newSrs } from "./scheduler";
import {
  accuracyByChapter,
  attemptsPerDay,
  overallAccuracy,
  practiceStreak,
  recentMistakes,
  reviewForecast,
  weakestPositions
} from "./stats";
import { makeAttempt, makeCatalog, makeChapters, makeLine, makeProgress } from "./testing";
import type { AttemptRecord, Result, SrsState } from "./types";

// Local noon, so the local calendar day is the same in any time zone the tests run in.
const local = (year: number, month: number, day: number, hour = 12): number => new Date(year, month - 1, day, hour).getTime();
const NOW = local(2026, 10, 1);

describe("practiceStreak", () => {
  it("counts back from today across a month boundary", () => {
    expect(practiceStreak(["2026-09-29", "2026-09-30", "2026-10-01"], NOW)).toEqual({ current: 3, practisedToday: true, longest: 3 });
  });

  it("counts from yesterday while today has no practice yet", () => {
    expect(practiceStreak(["2026-09-28", "2026-09-29", "2026-09-30"], NOW)).toEqual({ current: 3, practisedToday: false, longest: 3 });
  });

  it("a missed day ends the current streak but not the longest", () => {
    const days = ["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-29", "2026-09-30", "2026-10-01"];
    expect(practiceStreak(days, NOW)).toEqual({ current: 3, practisedToday: true, longest: 4 });
    // Neither today nor yesterday: no current streak.
    expect(practiceStreak(["2026-09-27", "2026-09-28", "2026-09-29"], NOW)).toEqual({ current: 0, practisedToday: false, longest: 3 });
  });

  it("handles a year boundary and the end of summer time", () => {
    expect(practiceStreak(["2026-12-30", "2026-12-31", "2027-01-01"], local(2027, 1, 1))).toMatchObject({ current: 3, longest: 3 });
    // EU summer time ends on 25 October 2026.
    expect(practiceStreak(["2026-10-24", "2026-10-25", "2026-10-26"], local(2026, 10, 26, 8))).toMatchObject({ current: 3, longest: 3 });
    // February in a non-leap year.
    expect(practiceStreak(["2027-02-27", "2027-02-28", "2027-03-01"], local(2027, 3, 1))).toMatchObject({ current: 3 });
  });

  it("ignores duplicates, order, malformed keys and days after today", () => {
    const days = ["2026-10-01", "2026-09-30", "2026-10-01", "nonsense", "2026-02-30", "2026-13-01", "2026-10-02", "2026-10-03", "2026-10-04"];
    expect(practiceStreak(days, NOW)).toEqual({ current: 2, practisedToday: true, longest: 2 });
    expect(practiceStreak([], NOW)).toEqual({ current: 0, practisedToday: false, longest: 0 });
  });

  it("agrees with dayKey for a time late in the evening", () => {
    const late = local(2026, 10, 1, 23);
    expect(practiceStreak([dayKey(late)], late)).toEqual({ current: 1, practisedToday: true, longest: 1 });
  });
});

describe("accuracy", () => {
  const ENGLISH = "English Opening";
  const lines = [
    makeLine({ id: "w-late", side: "white", moves: "1.c4 e5", chapterId: "w-two", family: ENGLISH, chapter: "1...c5: the Symmetrical", order: 20 }),
    makeLine({ id: "w-first", side: "white", moves: "1.c4 Nf6", chapterId: "w-one", family: ENGLISH, chapter: "1...e5: the Reversed Sicilian", order: 10 }),
    makeLine({ id: "b-only", side: "black", moves: "1.e4 c6", chapterId: "b-one", family: "Caro-Kann Defence", chapter: "Caro-Kann Defence", order: 0 }),
    makeLine({ id: "w-empty", side: "white", moves: "1.c4 g6", chapterId: "w-three", family: ENGLISH, chapter: "1...g6", order: 30 })
  ];
  const catalog = makeCatalog(lines, makeChapters(lines));
  const attempt = (lineId: string | null, result: Result, mode: AttemptRecord["mode"] = "next-move", at = NOW): AttemptRecord =>
    makeAttempt({ at, day: dayKey(at), lineId, result, mode });
  const attempts = [
    attempt("w-first", "clean"),
    attempt("w-first", "retried", "play-line"),
    attempt("w-first", "clean", "play-line"),
    attempt("w-late", "revealed"),
    attempt("b-only", "clean"),
    // Not position or line practice:
    attempt("w-late", "clean", "recall"),
    attempt("w-late", "clean", "sparring"),
    // No longer in the catalog, or without a line:
    attempt("deleted-custom-line", "clean"),
    attempt(null, "clean")
  ];

  it("groups position and line practice by chapter: White first, then chapter order", () => {
    expect(accuracyByChapter(attempts, catalog)).toEqual([
      { id: "w-one", label: "English Opening · 1...e5: the Reversed Sicilian", side: "white", attempts: 3, clean: 2, accuracy: 2 / 3 },
      { id: "w-two", label: "English Opening · 1...c5: the Symmetrical", side: "white", attempts: 1, clean: 0, accuracy: 0 },
      { id: "w-three", label: "English Opening · 1...g6", side: "white", attempts: 0, clean: 0, accuracy: null },
      { id: "b-one", label: "Caro-Kann Defence", side: "black", attempts: 1, clean: 1, accuracy: 1 }
    ]);
  });

  it("overall accuracy counts every attempt given", () => {
    expect(overallAccuracy(attempts)).toEqual({ attempts: 9, clean: 7, accuracy: 7 / 9 });
    expect(overallAccuracy([])).toEqual({ attempts: 0, clean: 0, accuracy: null });
  });
});

describe("recentMistakes", () => {
  const at = (hours: number) => NOW - hours * 3_600_000;
  const record = (id: number, hours: number, result: Result, posKey: string | null, extra: Partial<AttemptRecord> = {}): AttemptRecord =>
    makeAttempt({ id, at: at(hours), day: dayKey(at(hours)), result, posKey, ...extra });
  const attempts = [
    record(1, 10, "retried", "white|a"),
    record(2, 1, "hinted", "white|a"),
    record(3, 5, "clean", "white|b"),
    record(4, 3, "revealed", "white|c"),
    record(5, 3, "retried", "white|d"),
    record(6, 2, "revealed", null, { mode: "recall", lineId: "line-1" }),
    record(7, 4, "revealed", null, { mode: "recall", lineId: "line-1" }),
    record(8, 6, "retried", null, { mode: "recall", lineId: "line-2" })
  ];

  it("lists attempts that were not clean, newest first, one per position", () => {
    expect(recentMistakes(attempts, 10).map((attempt) => attempt.id)).toEqual([2, 6, 5, 4, 8]);
  });

  it("stops at the limit", () => {
    expect(recentMistakes(attempts, 2).map((attempt) => attempt.id)).toEqual([2, 6]);
    expect(recentMistakes(attempts, 0)).toEqual([]);
    expect(recentMistakes([], 5)).toEqual([]);
  });

  it("does not depend on the input order, even for unsaved attempts at the same time", () => {
    const unsaved = ["white|z", "white|x", "white|y"].map((posKey) => makeAttempt({ at: NOW, day: dayKey(NOW), result: "retried", posKey }));
    const keys = (list: AttemptRecord[]) => recentMistakes(list, 10).map((attempt) => attempt.posKey);
    expect(keys(unsaved)).toEqual(["white|x", "white|y", "white|z"]);
    expect(keys([...unsaved].reverse())).toEqual(["white|x", "white|y", "white|z"]);
    expect(keys([...attempts].reverse()).length).toBe(5);
    expect(recentMistakes([...attempts].reverse(), 10)).toEqual(recentMistakes(attempts, 10));
  });
});

describe("weakestPositions", () => {
  it("lists attempted positions, lowest mastery first, then the most lapses, then by key", () => {
    const lapses = (count: number): SrsState => ({ ...newSrs(), box: 1, lapses: count });
    const progress = [
      makeProgress("white", "c", { attempts: 2, mastery: 0.3, srs: lapses(1) }),
      makeProgress("white", "a", { attempts: 1, mastery: 0.3, srs: lapses(1) }),
      makeProgress("white", "b", { attempts: 4, mastery: 0.3, srs: lapses(3) }),
      makeProgress("white", "d", { attempts: 1, mastery: 0.1 }),
      makeProgress("white", "e", { attempts: 0, mastery: 0 }),
      makeProgress("white", "f", { attempts: 1, mastery: 0.9 })
    ];
    expect(weakestPositions(progress, 10).map((record) => record.epd)).toEqual(["d", "b", "a", "c", "f"]);
    expect(weakestPositions(progress, 2).map((record) => record.epd)).toEqual(["d", "b"]);
    expect(weakestPositions(progress, 0)).toEqual([]);
  });
});

describe("reviewForecast", () => {
  const due = (at: number): SrsState => ({ ...newSrs(), box: 2, dueAt: at });

  it("counts reviews per local day from today; today includes everything overdue", () => {
    const states = [
      due(NOW - 10 * DAY_MS),
      due(local(2026, 10, 1, 0)),
      due(local(2026, 10, 1, 23)),
      due(local(2026, 10, 2, 1)),
      due(local(2026, 10, 7, 22)),
      due(local(2026, 10, 8, 9)),
      newSrs()
    ];
    expect(reviewForecast(states, NOW, 7)).toEqual([
      { day: "2026-10-01", count: 3 },
      { day: "2026-10-02", count: 1 },
      { day: "2026-10-03", count: 0 },
      { day: "2026-10-04", count: 0 },
      { day: "2026-10-05", count: 0 },
      { day: "2026-10-06", count: 0 },
      { day: "2026-10-07", count: 1 }
    ]);
  });

  it("returns nothing for no days", () => {
    expect(reviewForecast([due(NOW)], NOW, 0)).toEqual([]);
  });

  it("crosses a month boundary", () => {
    const end = local(2026, 9, 30);
    expect(reviewForecast([due(local(2026, 10, 1, 8))], end, 2)).toEqual([
      { day: "2026-09-30", count: 0 },
      { day: "2026-10-01", count: 1 }
    ]);
  });
});

describe("attemptsPerDay", () => {
  it("counts attempts and clean ones per day, oldest first, ending today", () => {
    const attempt = (day: string, result: Result) => makeAttempt({ at: NOW, day, result });
    const attempts = [
      attempt("2026-09-29", "clean"),
      attempt("2026-09-29", "retried"),
      attempt("2026-10-01", "clean"),
      attempt("2026-09-28", "clean"),
      attempt("2026-10-02", "clean")
    ];
    expect(attemptsPerDay(attempts, NOW, 3)).toEqual([
      { day: "2026-09-29", attempts: 2, clean: 1 },
      { day: "2026-09-30", attempts: 0, clean: 0 },
      { day: "2026-10-01", attempts: 1, clean: 1 }
    ]);
    expect(attemptsPerDay(attempts, NOW, 0)).toEqual([]);
  });
});

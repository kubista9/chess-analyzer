import { describe, expect, it } from "vitest";
import type { PositionItem } from "../content/types";
import { DAY_MS } from "../util/time";
import {
  PRIORITY_WEIGHT,
  buildQueue,
  dueCount,
  dueLines,
  dueScore,
  newIntroducedToday,
  nextDueAt,
  remainingNewToday
} from "./queue";
import { newLineProgress } from "./mastery";
import { newSrs } from "./scheduler";
import { makeItems, makeLine, makeProgress, makeTree } from "./testing";
import type { LineProgress, PositionProgress, Result, SrsState } from "./types";

// Local noon, so "today" is the same calendar day in any time zone the tests run in.
const NOW = new Date(2026, 9, 1, 12).getTime();

const SIDELINE = makeLine({ id: "c-sideline", side: "white", moves: "1.c4 c5 2.Nf3", priority: "sideline", order: 0 });
const MAIN = makeLine({ id: "a-main", side: "white", moves: "1.c4 e5 2.Nc3 Nf6 3.g3", priority: "main", order: 1 });
const SECONDARY = makeLine({ id: "b-secondary", side: "white", moves: "1.c4 e5 2.Nc3 Nc6 3.g3", priority: "secondary", order: 2 });
const MAIN_LATER = makeLine({ id: "d-main", side: "white", moves: "1.c4 Nf6 2.Nc3", priority: "main", order: 3 });
const LINES = [SIDELINE, MAIN, SECONDARY, MAIN_LATER];
const ITEMS = makeItems(makeTree("white", LINES), LINES);

/** The item where the user plays the move after `sans` (by its path). */
function itemAfter(path: string): PositionItem {
  const item = ITEMS.find((candidate) => candidate.pathSans.join(" ") === path);
  if (!item) {
    throw new Error(`no item after "${path}"`);
  }
  return item;
}

const START = itemAfter("");
const AFTER_E5 = itemAfter("c4 e5");
const AFTER_NF6 = itemAfter("c4 e5 Nc3 Nf6");
const AFTER_NC6 = itemAfter("c4 e5 Nc3 Nc6");
const AFTER_C5 = itemAfter("c4 c5");
const AFTER_1NF6 = itemAfter("c4 Nf6");

interface DueSpec {
  overdueDays?: number;
  intervalDays?: number;
  lapses?: number;
  lastResult?: Result;
  practisedDaysAgo?: number;
  mastery?: number;
}

/** A seen position whose review fell due `overdueDays` ago on an `intervalDays` interval. */
function seen(item: PositionItem, spec: DueSpec = {}): PositionProgress {
  const overdue = spec.overdueDays ?? 0;
  const interval = spec.intervalDays ?? 1;
  const dueAt = NOW - overdue * DAY_MS;
  const lastReviewAt = dueAt - interval * DAY_MS;
  const srs: SrsState = { box: 2, dueAt, introducedAt: lastReviewAt, lapses: spec.lapses ?? 0, streak: 0, reviews: 1, lastReviewAt };
  return makeProgress(item.side, item.epd, {
    attempts: 1,
    firstSeenAt: lastReviewAt,
    lastPracticedAt: spec.practisedDaysAgo === undefined ? lastReviewAt : NOW - spec.practisedDaysAgo * DAY_MS,
    lastResult: spec.lastResult ?? "clean",
    recent: [spec.lastResult ?? "clean"],
    mastery: spec.mastery ?? 0.5,
    srs
  });
}

const progressOf = (...records: PositionProgress[]) => new Map(records.map((record) => [record.key, record]));
const keysOf = (entries: { item: PositionItem }[]) => entries.map((entry) => entry.item.key);

describe("buildQueue: new positions", () => {
  it("introduces new positions in teaching order: main lines first, then line order, then ply", () => {
    const queue = buildQueue(ITEMS, new Map(), { now: NOW, newLimit: 10 });
    expect(keysOf(queue)).toEqual(keysOf([START, AFTER_E5, AFTER_NF6, AFTER_1NF6, AFTER_NC6, AFTER_C5].map((item) => ({ item }))));
    expect(queue.every((entry) => entry.reason === "new" && entry.score === 0 && entry.progress === null)).toBe(true);
  });

  it("caps new positions at newLimit, whatever order the items come in", () => {
    const reversed = [...ITEMS].reverse();
    expect(keysOf(buildQueue(reversed, new Map(), { now: NOW, newLimit: 2 }))).toEqual([START.key, AFTER_E5.key]);
    expect(buildQueue(ITEMS, new Map(), { now: NOW, newLimit: 0 })).toEqual([]);
    expect(buildQueue(ITEMS, new Map(), { now: NOW, newLimit: -3 })).toEqual([]);
    expect(buildQueue(ITEMS, new Map(), { now: NOW, newLimit: Number.NaN })).toEqual([]);
  });

  it("a stored record still in box 0 counts as new", () => {
    const record = makeProgress("white", START.epd);
    const queue = buildQueue(ITEMS, progressOf(record), { now: NOW, newLimit: 1 });
    expect(queue).toEqual([{ item: START, reason: "new", score: 0, progress: record }]);
  });

  it("lists each position once", () => {
    const queue = buildQueue([...ITEMS, ...ITEMS], new Map(), { now: NOW, newLimit: 100 });
    expect(new Set(keysOf(queue)).size).toBe(ITEMS.length);
    expect(queue).toHaveLength(ITEMS.length);
  });
});

describe("buildQueue: due positions", () => {
  it("puts due positions before new ones, and leaves out seen positions that are not due", () => {
    const due = seen(AFTER_C5, { overdueDays: 0 });
    const notDue = seen(START, { overdueDays: -3 });
    const queue = buildQueue(ITEMS, progressOf(due, notDue), { now: NOW, newLimit: 2 });
    expect(queue.map((entry) => [entry.item.key, entry.reason])).toEqual([
      [AFTER_C5.key, "due"],
      [AFTER_E5.key, "new"],
      [AFTER_NF6.key, "new"]
    ]);
    expect(queue[0].progress).toBe(due);
  });

  it("scores (1 + overdue ratio) · lapse factor · priority weight · error factor + staleness", () => {
    expect(PRIORITY_WEIGHT).toEqual({ main: 3, secondary: 2, sideline: 1 });
    const record = seen(AFTER_NC6, { overdueDays: 2, intervalDays: 4, lapses: 2, lastResult: "revealed", practisedDaysAgo: 15 });
    // (1 + 2/4) · (1 + 0.5·2) · 2 · 1.5 + 15/30
    expect(dueScore(AFTER_NC6, record, NOW)).toBeCloseTo(1.5 * 2 * 2 * 1.5 + 0.5, 9);
    // Lapses count up to 4.
    const many = seen(AFTER_NC6, { overdueDays: 0, lapses: 9, practisedDaysAgo: 0 });
    expect(dueScore(AFTER_NC6, many, NOW)).toBeCloseTo(1 * 3 * 2, 9);
  });

  it("prioritises recent errors and lapses among otherwise equal positions", () => {
    const plain = seen(AFTER_E5, { overdueDays: 1, practisedDaysAgo: 2 });
    const retried = seen(AFTER_NF6, { overdueDays: 1, practisedDaysAgo: 2, lastResult: "retried" });
    const hinted = seen(AFTER_1NF6, { overdueDays: 1, practisedDaysAgo: 2, lastResult: "hinted" });
    const lapsed = seen(START, { overdueDays: 1, practisedDaysAgo: 2, lapses: 1 });
    const queue = buildQueue(ITEMS, progressOf(plain, retried, hinted, lapsed), { now: NOW, newLimit: 0 });
    // Lapse ×1.5 and retry ×1.5 tie; the key breaks the tie. Hinted is not an error.
    const tied = [START.key, AFTER_NF6.key].sort();
    expect(keysOf(queue)).toEqual([...tied, ...[AFTER_E5.key, AFTER_1NF6.key].sort()]);
    expect(queue[0].score).toBeCloseTo(queue[1].score, 12);
    expect(queue[1].score).toBeGreaterThan(queue[2].score);
    expect(queue[2].score).toBeCloseTo(queue[3].score, 12);
  });

  it("ranks main lines above sidelines and the more overdue first", () => {
    const sideline = seen(AFTER_C5, { overdueDays: 1, practisedDaysAgo: 2 });
    const main = seen(AFTER_E5, { overdueDays: 1, practisedDaysAgo: 2 });
    const secondary = seen(AFTER_NC6, { overdueDays: 1, practisedDaysAgo: 2 });
    const veryLate = seen(AFTER_1NF6, { overdueDays: 5, practisedDaysAgo: 6 });
    const queue = buildQueue(ITEMS, progressOf(sideline, main, secondary, veryLate), { now: NOW, newLimit: 0 });
    expect(keysOf(queue)).toEqual([AFTER_1NF6.key, AFTER_E5.key, AFTER_NC6.key, AFTER_C5.key]);
  });

  it("caps the whole queue at limit, due positions first", () => {
    const records = [seen(AFTER_C5, { overdueDays: 3 }), seen(AFTER_E5, { overdueDays: 2 }), seen(AFTER_NF6, { overdueDays: 1 })];
    const queue = buildQueue(ITEMS, progressOf(...records), { now: NOW, newLimit: 5, limit: 2 });
    expect(queue.map((entry) => entry.reason)).toEqual(["due", "due"]);
    const roomy = buildQueue(ITEMS, progressOf(...records), { now: NOW, newLimit: 5, limit: 4 });
    expect(roomy.map((entry) => entry.reason)).toEqual(["due", "due", "due", "new"]);
    expect(roomy[3].item.key).toBe(START.key);
    expect(buildQueue(ITEMS, progressOf(...records), { now: NOW, newLimit: 5, limit: 0 })).toEqual([]);
  });
});

describe("buildQueue: extra practice", () => {
  const weak = seen(AFTER_E5, { overdueDays: -5, mastery: 0.2, practisedDaysAgo: 1 });
  // Equal mastery: the key order alone (AFTER_NF6 first) would put the recently practised one first.
  const strongOld = seen(AFTER_1NF6, { overdueDays: -5, mastery: 0.8, practisedDaysAgo: 9 });
  const strongRecent = seen(AFTER_NF6, { overdueDays: -5, mastery: 0.8, practisedDaysAgo: 1 });
  const due = seen(AFTER_C5, { overdueDays: 1 });
  const progress = progressOf(weak, strongOld, strongRecent, due);

  it("fills a short queue with seen positions that are not due: weakest first, then least recently practised", () => {
    expect(AFTER_NF6.key < AFTER_1NF6.key).toBe(true);
    const queue = buildQueue(ITEMS, progress, { now: NOW, newLimit: 1, limit: 5, includeExtra: true });
    expect(queue.map((entry) => [entry.item.key, entry.reason])).toEqual([
      [AFTER_C5.key, "due"],
      [START.key, "new"],
      [AFTER_E5.key, "extra"],
      [AFTER_1NF6.key, "extra"],
      [AFTER_NF6.key, "extra"]
    ]);
    expect(queue[2].score).toBeCloseTo(0.8, 12);
    expect(queue[2].progress).toBe(weak);
  });

  it("stops at the limit and adds nothing without includeExtra", () => {
    expect(buildQueue(ITEMS, progress, { now: NOW, newLimit: 0, limit: 2, includeExtra: true }).map((entry) => entry.reason)).toEqual([
      "due",
      "extra"
    ]);
    expect(buildQueue(ITEMS, progress, { now: NOW, newLimit: 0, limit: 5 }).map((entry) => entry.reason)).toEqual(["due"]);
  });

  it("without a limit adds every seen position that is not due", () => {
    const queue = buildQueue(ITEMS, progress, { now: NOW, newLimit: 0, includeExtra: true });
    expect(queue.filter((entry) => entry.reason === "extra")).toHaveLength(3);
  });
});

describe("daily counts", () => {
  it("counts positions first seen on today's local day", () => {
    const today = new Date(2026, 9, 1, 0, 0, 1).getTime();
    const lateToday = new Date(2026, 9, 1, 23, 59).getTime();
    const yesterday = new Date(2026, 8, 30, 23, 59).getTime();
    const records = [
      makeProgress("white", "a", { firstSeenAt: today }),
      makeProgress("white", "b", { firstSeenAt: lateToday }),
      makeProgress("white", "c", { firstSeenAt: yesterday }),
      makeProgress("white", "d", { firstSeenAt: null })
    ];
    expect(newIntroducedToday(records, NOW)).toBe(2);
    expect(newIntroducedToday(records, yesterday)).toBe(1);
    expect(newIntroducedToday([], NOW)).toBe(0);
  });

  it("leaves the rest of the daily allowance, never below 0", () => {
    expect(remainingNewToday(10, 0)).toBe(10);
    expect(remainingNewToday(10, 3)).toBe(7);
    expect(remainingNewToday(10, 10)).toBe(0);
    expect(remainingNewToday(10, 14)).toBe(0);
    expect(remainingNewToday(0, 0)).toBe(0);
    expect(remainingNewToday(Number.NaN, 0)).toBe(0);
    expect(remainingNewToday(Number.POSITIVE_INFINITY, 5)).toBe(Number.POSITIVE_INFINITY);
  });

  it("the cap feeds the queue: today's introductions use up new slots", () => {
    const introduced = [seen(START, { overdueDays: -1 })].map((record) => ({ ...record, firstSeenAt: NOW - 60_000 }));
    const slots = remainingNewToday(3, newIntroducedToday(introduced, NOW));
    expect(slots).toBe(2);
    const queue = buildQueue(ITEMS, progressOf(...introduced), { now: NOW, newLimit: slots });
    expect(keysOf(queue)).toEqual([AFTER_E5.key, AFTER_NF6.key]);
  });

  it("counts due positions", () => {
    const records = progressOf(seen(START, { overdueDays: 0 }), seen(AFTER_E5, { overdueDays: 3 }), seen(AFTER_NF6, { overdueDays: -1 }));
    expect(dueCount(ITEMS, records, NOW)).toBe(2);
    expect(dueCount([...ITEMS, START], records, NOW)).toBe(2);
    expect(dueCount(ITEMS, new Map(), NOW)).toBe(0);
  });
});

describe("dueLines and nextDueAt", () => {
  function lineRecord(lineId: string, overdueDays: number, intervalDays: number): LineProgress {
    const dueAt = NOW - overdueDays * DAY_MS;
    return {
      ...newLineProgress(lineId),
      runs: 1,
      srs: { box: 2, dueAt, introducedAt: dueAt - intervalDays * DAY_MS, lapses: 0, streak: 1, reviews: 1, lastReviewAt: dueAt - intervalDays * DAY_MS }
    };
  }

  it("lists lines with a due review, most overdue first; never-run and not-yet-due lines are left out", () => {
    const records = new Map<string, LineProgress>([
      [SIDELINE.id, lineRecord(SIDELINE.id, 2, 1)], // ratio 2
      [MAIN.id, lineRecord(MAIN.id, 3, 7)], // ratio 3/7
      [SECONDARY.id, lineRecord(SECONDARY.id, -1, 1)] // not due
    ]);
    expect(dueLines(LINES, records, NOW).map((line) => line.id)).toEqual([SIDELINE.id, MAIN.id]);
    expect(dueLines(LINES, new Map(), NOW)).toEqual([]);
  });

  it("breaks ties by the earliest due time, then teaching order", () => {
    const records = new Map<string, LineProgress>([
      [MAIN_LATER.id, lineRecord(MAIN_LATER.id, 0, 1)],
      [MAIN.id, lineRecord(MAIN.id, 0, 1)],
      [SECONDARY.id, lineRecord(SECONDARY.id, 0.5, 1e9)]
    ]);
    // SECONDARY is barely overdue (tiny ratio) but due earliest; the other two tie at ratio 0.
    expect(dueLines(LINES, records, NOW).map((line) => line.id)).toEqual([SECONDARY.id, MAIN.id, MAIN_LATER.id]);
  });

  it("finds the earliest due time among introduced items", () => {
    const states: SrsState[] = [
      newSrs(),
      { ...newSrs(), box: 2, dueAt: NOW + 5 * DAY_MS },
      { ...newSrs(), box: 1, dueAt: NOW - DAY_MS },
      { ...newSrs(), box: 0, dueAt: NOW - 10 * DAY_MS }
    ];
    expect(nextDueAt(states)).toBe(NOW - DAY_MS);
    expect(nextDueAt([newSrs()])).toBeNull();
    expect(nextDueAt([])).toBeNull();
  });
});

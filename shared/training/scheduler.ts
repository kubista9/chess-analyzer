// One Leitner scheduler for both drill kinds, with parameters per kind. Pure: every function
// takes the clock (ms) as an argument, so tests run on a fixed clock.
//
// A card starts in box 0 ("new": never shown). It is introduced into box 1, due at once, when
// the day's new-card slots of its kind allow (a mistake card only after its deep check). A
// correct first try in box b schedules it `boxesDays[b - 1]` days ahead (±5% fuzz from its id)
// and moves it to box b + 1 (the last box repeats). A wrong answer sends it back to box 1, due
// tomorrow, with a lapse. A mistake card retires after RETIRE_STREAK correct answers in a row
// once its interval reaches RETIRE_MIN_DAYS.

export type DrillKind = "repertoire-line" | "own-mistake";

export const DRILL_KINDS: readonly DrillKind[] = ["repertoire-line", "own-mistake"];

export const DAY_MS = 86_400_000;

export interface KindSchedule {
  /** The interval after a correct answer in box b (1-based) is boxesDays[b - 1] days. */
  boxesDays: readonly number[];
  /** New cards introduced per day. */
  newPerDay: number;
  /** null: the card never retires. */
  retire: { streak: number; minIntervalDays: number } | null;
}

export const SCHEDULES: Record<DrillKind, KindSchedule> = {
  "repertoire-line": { boxesDays: [1, 3, 7, 16, 35, 60], newPerDay: 5, retire: null },
  "own-mistake": { boxesDays: [2, 5, 14, 30, 90], newPerDay: 5, retire: { streak: 3, minIntervalDays: 21 } }
};

/** A wrong answer is due again after this many days. */
export const LAPSE_DAYS = 1;

/** The fuzz on intervals: ±5%. */
export const FUZZ = 0.05;

export interface SrsState {
  /** 0 = new (never introduced), else 1..boxesDays.length. */
  box: number;
  /** ms; null while new. */
  dueAt: number | null;
  introducedAt: number | null;
  lapses: number;
  /** Correct answers in a row. */
  streak: number;
  reviews: number;
  lastReviewAt: number | null;
  /** A learned mistake card (it comes back if the mistake recurs). */
  retired: boolean;
}

export function newState(): SrsState {
  return { box: 0, dueAt: null, introducedAt: null, lapses: 0, streak: 0, reviews: 0, lastReviewAt: null, retired: false };
}

/** FNV-1a: a small deterministic hash. */
export function hash32(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/** A deterministic factor in [1 - FUZZ, 1 + FUZZ] from the card id and the box. */
export function fuzzFactor(id: string, box: number): number {
  const unit = hash32(`${id}#${box}`) / 0xffffffff;
  return 1 - FUZZ + unit * 2 * FUZZ;
}

/** The interval in days after a correct answer in `box`. */
export function intervalDays(kind: DrillKind, box: number): number {
  const boxes = SCHEDULES[kind].boxesDays;
  return boxes[Math.min(Math.max(box, 1), boxes.length) - 1];
}

/** Puts a new card into box 1, due now. */
export function introduce(state: SrsState, now: number): SrsState {
  return { ...state, box: 1, dueAt: now, introducedAt: now, retired: false };
}

export type Outcome = "correct" | "wrong";

/** The state after a graded answer at `now`. */
export function grade(kind: DrillKind, id: string, state: SrsState, outcome: Outcome, now: number): SrsState {
  const base = state.box === 0 ? introduce(state, now) : state;
  const reviewed = { ...base, reviews: base.reviews + 1, lastReviewAt: now };
  if (outcome === "wrong") {
    return { ...reviewed, box: 1, dueAt: now + LAPSE_DAYS * DAY_MS, lapses: base.lapses + 1, streak: 0, retired: false };
  }
  const boxes = SCHEDULES[kind].boxesDays;
  const days = intervalDays(kind, base.box);
  const streak = base.streak + 1;
  const retire = SCHEDULES[kind].retire;
  return {
    ...reviewed,
    box: Math.min(base.box + 1, boxes.length),
    dueAt: now + Math.round(days * DAY_MS * fuzzFactor(id, base.box)),
    streak,
    retired: retire !== null && streak >= retire.streak && days >= retire.minIntervalDays
  };
}

/** Brings a card back because its mistake recurred: box 1, due now, one more lapse. */
export function resetForRecurrence(state: SrsState, now: number): SrsState {
  return { ...state, box: 1, dueAt: now, introducedAt: state.introducedAt ?? now, lapses: state.lapses + 1, streak: 0, retired: false };
}

export function isDue(state: SrsState, now: number): boolean {
  return !state.retired && state.box > 0 && state.dueAt !== null && state.dueAt <= now;
}

/**
 * Session order: the overdue ratio times the card's weight. The ratio is 1 when the card is due
 * just now and grows by 1 per interval it is late; a new card counts as due now.
 */
export function sessionPriority(kind: DrillKind, state: SrsState, weight: number, now: number): number {
  if (state.box === 0 || state.dueAt === null) {
    return weight;
  }
  const intervalMs = Math.max(1, state.box > 1 ? intervalDays(kind, state.box - 1) : LAPSE_DAYS) * DAY_MS;
  return (1 + Math.max(0, now - state.dueAt) / intervalMs) * weight;
}

/** The local midnight before `now`: the day the new-card cap counts. */
export function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** New cards of `kind` that may still be introduced today. */
export function newSlots(kind: DrillKind, introducedToday: number): number {
  return Math.max(0, SCHEDULES[kind].newPerDay - introducedToday);
}

import { hash32 } from "../util/random";
import { DAY_MS } from "../util/time";
import type { Outcome, SrsState } from "./types";

// Leitner boxes for spaced review: one schedule for positions and for lines. Pure: every function
// takes the clock (ms) as an argument, so tests run on a fixed clock.
//
// An item starts in box 0 ("new": never shown). Its first graded answer introduces it into box 1
// and then applies the outcome:
// - good: due BOX_DAYS[b - 1] days later (±FUZZ, fixed per item and box), and up one box (the last
//   box repeats its interval);
// - hard: same box, due after half that interval (at least a day);
// - again: back to box 1, due after LAPSE_DAYS, with one more lapse (the session re-asks it too).

/** Days until the next review after a good answer in box b: BOX_DAYS[b - 1] (days). */
export const BOX_DAYS = [1, 3, 7, 16, 35, 60] as const;

/** The highest box (a box number). */
export const LAST_BOX = BOX_DAYS.length;

/** Interval fuzz as a fraction of the interval: ±5%, deterministic per item id and box. */
export const FUZZ = 0.05;

/** Days until an item answered "again" is due (days). */
export const LAPSE_DAYS = 1;

/** The shortest interval after a "hard" answer (days). */
export const MIN_HARD_DAYS = 1;

/** A new item: box 0, never shown. */
export function newSrs(): SrsState {
  return { box: 0, dueAt: null, introducedAt: null, lapses: 0, streak: 0, reviews: 0, lastReviewAt: null };
}

/** A deterministic factor in [1 - FUZZ, 1 + FUZZ] from the item id and the box (FNV-1a). */
export function fuzzFactor(id: string, box: number): number {
  const unit = hash32(`${id}#${box}`) / 0xffffffff;
  return 1 - FUZZ + unit * 2 * FUZZ;
}

/** Box number clamped to 1..LAST_BOX (anything unreadable counts as box 1). */
function clampBox(box: number): number {
  if (!Number.isFinite(box)) {
    return 1;
  }
  return Math.min(Math.max(Math.trunc(box), 1), LAST_BOX);
}

/** The interval in days after a good answer in `box` (clamped to 1..LAST_BOX). */
export function intervalDays(box: number): number {
  return BOX_DAYS[clampBox(box) - 1];
}

function afterDays(now: number, days: number): number {
  return now + Math.round(days * DAY_MS);
}

/** The state after a graded answer at `now`. A new item is introduced into box 1 first. */
export function grade(id: string, state: SrsState, outcome: Outcome, now: number): SrsState {
  const introduced = !(state.box >= 1);
  const box = introduced ? 1 : clampBox(state.box);
  const reviewed: SrsState = {
    ...state,
    box,
    introducedAt: introduced ? now : state.introducedAt,
    reviews: state.reviews + 1,
    lastReviewAt: now
  };
  if (outcome === "good") {
    return {
      ...reviewed,
      box: Math.min(box + 1, LAST_BOX),
      dueAt: afterDays(now, intervalDays(box) * fuzzFactor(id, box)),
      streak: state.streak + 1
    };
  }
  if (outcome === "hard") {
    return { ...reviewed, dueAt: afterDays(now, Math.max(MIN_HARD_DAYS, intervalDays(box) / 2) * fuzzFactor(id, box)), streak: 0 };
  }
  return { ...reviewed, box: 1, dueAt: afterDays(now, LAPSE_DAYS), lapses: state.lapses + 1, streak: 0 };
}

/** True when the item has been introduced and its review time has come. */
export function isDue(state: SrsState, now: number): boolean {
  return state.box > 0 && state.dueAt !== null && state.dueAt <= now;
}

/** True while the item has never been answered. */
export function isNew(state: SrsState): boolean {
  return state.box === 0;
}

/**
 * The interval the item is actually on, in ms: from its last review to its due time. That is the
 * interval grade() chose (a good, hard or again answer, fuzz included), so the last box counts
 * its own 60 days rather than the previous box's. Without a review on record (a hand-made or
 * imported state) the nominal interval that leads into the box is used.
 */
function scheduledIntervalMs(state: SrsState): number {
  if (state.lastReviewAt !== null && state.dueAt !== null && state.dueAt > state.lastReviewAt) {
    return state.dueAt - state.lastReviewAt;
  }
  const box = clampBox(state.box);
  return (box === 1 ? LAPSE_DAYS : intervalDays(box - 1)) * DAY_MS;
}

/** How late the item is, in units of its current interval: 0 when not yet due (never negative). */
export function overdueRatio(state: SrsState, now: number): number {
  if (state.box <= 0 || state.dueAt === null || now <= state.dueAt) {
    return 0;
  }
  return (now - state.dueAt) / scheduledIntervalMs(state);
}

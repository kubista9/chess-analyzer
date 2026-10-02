import { PRIORITIES, type Priority } from "../content/schema";
import type { Line, PositionItem } from "../content/types";
import { DAY_MS, dayKey } from "../util/time";
import { isDue, isNew, overdueRatio } from "./scheduler";
import type { LineProgress, PositionProgress, SrsState } from "./types";

// The practice queue: due positions first (the most urgent first), then today's new positions in
// teaching order (main lines first), then optional extra practice on seen positions that are not
// due. Deterministic: every sort ends on the item key.

/** How much a line's priority weighs in the due order (a factor). */
export const PRIORITY_WEIGHT: Record<Priority, number> = { main: 3, secondary: 2, sideline: 1 };

/** Each lapse raises a due position's urgency by this share, up to MAX_COUNTED_LAPSES (a factor per lapse). */
export const LAPSE_WEIGHT = 0.5;

/** Lapses beyond this many do not raise urgency further (lapses). */
export const MAX_COUNTED_LAPSES = 4;

/** Urgency factor for a position whose last result was a retry or a reveal (a factor). */
export const RECENT_ERROR_WEIGHT = 1.5;

/** Days since the last practice that add 1 to a due position's urgency (days). */
export const STALENESS_DAYS = 30;

/** One position of the practice queue and why it is there. */
export interface QueueEntry {
  item: PositionItem;
  reason: "due" | "new" | "extra";
  /** The due urgency (higher first); for new entries 0, for extra entries 1 − mastery. */
  score: number;
  progress: PositionProgress | null;
}

const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const priorityRank = (priority: Priority): number => PRIORITIES.indexOf(priority);

/** Teaching order: priority (main first), then the line order, then the ply, then the key. */
function teachingOrder(left: PositionItem, right: PositionItem): number {
  return (
    priorityRank(left.priority) - priorityRank(right.priority) ||
    left.order - right.order ||
    left.minPly - right.minPly ||
    byText(left.key, right.key)
  );
}

/**
 * (1 + overdueRatio) · (1 + LAPSE_WEIGHT · min(lapses, MAX_COUNTED_LAPSES)) · PRIORITY_WEIGHT
 * · (RECENT_ERROR_WEIGHT after a retry or a reveal) + days since the last practice / STALENESS_DAYS.
 */
export function dueScore(item: PositionItem, progress: PositionProgress, now: number): number {
  const lapses = Math.min(Math.max(progress.srs.lapses, 0), MAX_COUNTED_LAPSES);
  const recentError = progress.lastResult === "retried" || progress.lastResult === "revealed" ? RECENT_ERROR_WEIGHT : 1;
  const daysSince = progress.lastPracticedAt === null ? 0 : Math.max(0, now - progress.lastPracticedAt) / DAY_MS;
  const urgency = (1 + overdueRatio(progress.srs, now)) * (1 + LAPSE_WEIGHT * lapses) * PRIORITY_WEIGHT[item.priority] * recentError;
  return urgency + daysSince / STALENESS_DAYS;
}

/** A whole, non-negative count; `fallback` when it is missing or not a number. */
function asCount(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

/**
 * Due positions (highest score first), then up to `newLimit` new positions in teaching order,
 * all capped at `limit`. With includeExtra, a queue shorter than `limit` is filled with seen
 * positions that are not due: the weakest first, then the least recently practised.
 */
export function buildQueue(
  items: readonly PositionItem[],
  progress: ReadonlyMap<string, PositionProgress>,
  options: { now: number; newLimit: number; limit?: number; includeExtra?: boolean }
): QueueEntry[] {
  const { now } = options;
  const limit = asCount(options.limit, Number.POSITIVE_INFINITY);
  const newLimit = asCount(options.newLimit, 0);
  const due: QueueEntry[] = [];
  const fresh: PositionItem[] = [];
  const rest: { item: PositionItem; progress: PositionProgress }[] = [];
  const seenKeys = new Set<string>();

  for (const item of items) {
    if (seenKeys.has(item.key)) {
      continue;
    }
    seenKeys.add(item.key);
    const record = progress.get(item.key);
    if (!record || isNew(record.srs)) {
      fresh.push(item);
    } else if (isDue(record.srs, now)) {
      due.push({ item, reason: "due", score: dueScore(item, record, now), progress: record });
    } else {
      rest.push({ item, progress: record });
    }
  }

  due.sort((left, right) => right.score - left.score || byText(left.item.key, right.item.key));
  const queue = due.slice(0, limit);

  fresh.sort(teachingOrder);
  for (const item of fresh.slice(0, newLimit)) {
    if (queue.length >= limit) {
      break;
    }
    queue.push({ item, reason: "new", score: 0, progress: progress.get(item.key) ?? null });
  }

  if (options.includeExtra) {
    rest.sort(
      (left, right) =>
        left.progress.mastery - right.progress.mastery ||
        (left.progress.lastPracticedAt ?? 0) - (right.progress.lastPracticedAt ?? 0) ||
        byText(left.item.key, right.item.key)
    );
    for (const entry of rest) {
      if (queue.length >= limit) {
        break;
      }
      queue.push({ item: entry.item, reason: "extra", score: 1 - entry.progress.mastery, progress: entry.progress });
    }
  }
  return queue;
}

/** Positions first seen on the local day of `now` (they use up today's new-position allowance). */
export function newIntroducedToday(progress: Iterable<PositionProgress>, now: number): number {
  const today = dayKey(now);
  let introduced = 0;
  for (const record of progress) {
    if (record.firstSeenAt !== null && dayKey(record.firstSeenAt) === today) {
      introduced += 1;
    }
  }
  return introduced;
}

/** New positions that may still be introduced today (never negative). */
export function remainingNewToday(newPerDay: number, introducedToday: number): number {
  if (!Number.isFinite(newPerDay)) {
    return newPerDay > 0 ? Number.POSITIVE_INFINITY : 0;
  }
  return Math.max(0, Math.floor(newPerDay) - Math.max(0, introducedToday));
}

/** How many of the items are due now. */
export function dueCount(items: readonly PositionItem[], progress: ReadonlyMap<string, PositionProgress>, now: number): number {
  const keys = new Set<string>();
  for (const item of items) {
    const record = progress.get(item.key);
    if (record && isDue(record.srs, now)) {
      keys.add(item.key);
    }
  }
  return keys.size;
}

/**
 * Lines whose Play the Line review is due, most overdue first (then the earliest due time, then
 * teaching order). Lines never run are not included: they are not due, only new.
 */
export function dueLines(lines: readonly Line[], lineProgress: ReadonlyMap<string, LineProgress>, now: number): Line[] {
  return lines
    .flatMap((line) => {
      const record = lineProgress.get(line.id);
      return record && isDue(record.srs, now) ? [{ line, ratio: overdueRatio(record.srs, now), dueAt: record.srs.dueAt ?? now }] : [];
    })
    .sort(
      (left, right) =>
        right.ratio - left.ratio || left.dueAt - right.dueAt || left.line.order - right.line.order || byText(left.line.id, right.line.id)
    )
    .map((entry) => entry.line);
}

/** The earliest due time among introduced items, or null when nothing is scheduled. */
export function nextDueAt(states: Iterable<SrsState>): number | null {
  let next: number | null = null;
  for (const state of states) {
    if (state.box > 0 && state.dueAt !== null && (next === null || state.dueAt < next)) {
      next = state.dueAt;
    }
  }
  return next;
}

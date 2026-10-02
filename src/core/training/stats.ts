import type { Color } from "../chess/position";
import type { Catalog, Chapter } from "../content/types";
import { DAY_MS, dayKey, daysBetween, shiftDayKey } from "../util/time";
import type { AttemptRecord, Mode, PositionProgress, SrsState } from "./types";

// Figures for the dashboard and the Progress page: the practice streak, accuracy, recent
// mistakes, the weakest positions and the review forecast. Days are local calendar days
// ("YYYY-MM-DD", see util/time).

const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** The modes whose attempts count towards chapter accuracy (position and line practice). */
export const ACCURACY_MODES: readonly Mode[] = ["next-move", "play-line"];

/** A day key as a whole day number (UTC days since the epoch), or null if it is not a real date. */
function dayNumber(key: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) {
    return null;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return Math.round(date.getTime() / DAY_MS);
}

/**
 * Days in a row with practice. `current` counts back from today, or from yesterday when today
 * has no practice yet (the streak is not broken until a whole day is missed). Days after today
 * and malformed keys are ignored.
 */
export function practiceStreak(days: readonly string[], now: number): { current: number; practisedToday: boolean; longest: number } {
  const today = dayNumber(dayKey(now));
  if (today === null) {
    return { current: 0, practisedToday: false, longest: 0 };
  }
  const practised = new Set<number>();
  for (const key of days) {
    const number = dayNumber(key);
    if (number !== null && number <= today) {
      practised.add(number);
    }
  }
  const practisedToday = practised.has(today);
  let current = 0;
  for (let day = practisedToday ? today : today - 1; practised.has(day); day -= 1) {
    current += 1;
  }
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of [...practised].sort((left, right) => left - right)) {
    run = previous !== null && day === previous + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  return { current, practisedToday, longest };
}

/** Clean share of the attempts in one group (a chapter). */
export interface GroupAccuracy {
  id: string;
  label: string;
  side: Color;
  attempts: number;
  clean: number;
  /** clean / attempts; null without attempts. */
  accuracy: number | null;
}

function chapterLabel(chapter: Chapter): string {
  return chapter.family === chapter.chapter ? chapter.chapter : `${chapter.family} · ${chapter.chapter}`;
}

/**
 * Position and line practice per chapter (attempts mapped through their line's chapter), for
 * every chapter of the catalog: White first, then chapter order. Attempts whose line is no
 * longer in the catalog are left out.
 */
export function accuracyByChapter(attempts: readonly AttemptRecord[], catalog: Catalog): GroupAccuracy[] {
  const totals = new Map<string, { attempts: number; clean: number }>();
  for (const attempt of attempts) {
    if (!ACCURACY_MODES.includes(attempt.mode) || attempt.lineId === null) {
      continue;
    }
    const chapterId = catalog.lineById.get(attempt.lineId)?.chapterId;
    if (chapterId === undefined || !catalog.chapterById.has(chapterId)) {
      continue;
    }
    const total = totals.get(chapterId) ?? { attempts: 0, clean: 0 };
    total.attempts += 1;
    total.clean += attempt.result === "clean" ? 1 : 0;
    totals.set(chapterId, total);
  }
  return [...catalog.chapters]
    .sort((left, right) => (left.side === right.side ? 0 : left.side === "white" ? -1 : 1) || left.order - right.order || byText(left.id, right.id))
    .map((chapter) => {
      const total = totals.get(chapter.id) ?? { attempts: 0, clean: 0 };
      return {
        id: chapter.id,
        label: chapterLabel(chapter),
        side: chapter.side,
        attempts: total.attempts,
        clean: total.clean,
        accuracy: total.attempts === 0 ? null : total.clean / total.attempts
      };
    });
}

/** Clean share over every attempt given (filter by mode first for a narrower figure). */
export function overallAccuracy(attempts: readonly AttemptRecord[]): { attempts: number; clean: number; accuracy: number | null } {
  const clean = attempts.filter((attempt) => attempt.result === "clean").length;
  return { attempts: attempts.length, clean, accuracy: attempts.length === 0 ? null : clean / attempts.length };
}

/** Newest first: by time, then by id (the store's insertion order), then by position key. */
function newestFirst(left: AttemptRecord, right: AttemptRecord): number {
  return right.at - left.at || (right.id ?? 0) - (left.id ?? 0) || byText(left.posKey ?? "", right.posKey ?? "");
}

/**
 * Attempts that were not clean, newest first, one per position (an attempt without a position,
 * such as a recall question, counts once per mode and line).
 */
export function recentMistakes(attempts: readonly AttemptRecord[], limit: number): AttemptRecord[] {
  if (!(limit > 0)) {
    return [];
  }
  const seen = new Set<string>();
  const mistakes: AttemptRecord[] = [];
  for (const attempt of [...attempts].sort(newestFirst)) {
    if (attempt.result === "clean") {
      continue;
    }
    const key = attempt.posKey ?? `${attempt.mode}|${attempt.lineId ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    mistakes.push(attempt);
    if (mistakes.length >= limit) {
      break;
    }
  }
  return mistakes;
}

/** Attempted positions, lowest mastery first, then the most lapses, then by key. */
export function weakestPositions(progress: Iterable<PositionProgress>, limit: number): PositionProgress[] {
  if (!(limit > 0)) {
    return [];
  }
  return [...progress]
    .filter((record) => record.attempts >= 1)
    .sort((left, right) => left.mastery - right.mastery || right.srs.lapses - left.srs.lapses || byText(left.key, right.key))
    .slice(0, limit);
}

/** Reviews due on each of the next `days` local days, starting today; today also counts everything overdue. */
export function reviewForecast(states: Iterable<SrsState>, now: number, days: number): { day: string; count: number }[] {
  const length = Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 0;
  const counts = new Array<number>(length).fill(0);
  for (const state of states) {
    if (state.box <= 0 || state.dueAt === null) {
      continue;
    }
    const offset = Math.max(0, daysBetween(now, state.dueAt));
    if (offset < length) {
      counts[offset] += 1;
    }
  }
  return counts.map((count, offset) => ({ day: shiftDayKey(now, offset), count }));
}

/** Attempts and clean attempts on each of the last `days` local days, oldest first, ending today. */
export function attemptsPerDay(attempts: readonly AttemptRecord[], now: number, days: number): { day: string; attempts: number; clean: number }[] {
  const length = Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 0;
  const series = Array.from({ length }, (_, index) => ({ day: shiftDayKey(now, index - (length - 1)), attempts: 0, clean: 0 }));
  const byDay = new Map(series.map((entry) => [entry.day, entry]));
  for (const attempt of attempts) {
    const entry = byDay.get(attempt.day);
    if (entry) {
      entry.attempts += 1;
      entry.clean += attempt.result === "clean" ? 1 : 0;
    }
  }
  return series;
}

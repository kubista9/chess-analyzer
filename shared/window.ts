// Time-window arithmetic shared by the server and the verify scripts.
// All values are Unix seconds (Chess.com's end_time unit), and all days are UTC days.

export const WINDOW_DAYS = 183;

const DAY_SECONDS = 86_400;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface WindowBounds {
  /** Inclusive lower bound, Unix seconds. */
  start: number;
  /** Inclusive upper bound, Unix seconds. */
  end: number;
}

/**
 * The last second of a UTC calendar day: "2026-09-26" -> 2026-09-26T23:59:59Z.
 * This is the meaning of `--asof`: every game that ended on that day counts.
 */
export function endOfUtcDay(date: string): number {
  const match = ISO_DATE.exec(date);
  const millis = Date.parse(`${date}T23:59:59Z`);
  if (!match || Number.isNaN(millis)) {
    throw new Error(`Expected a YYYY-MM-DD date, got "${date}"`);
  }

  // Date.parse rolls invalid days over (2026-02-30 -> 2026-03-02), so round-trip the date.
  if (new Date(millis).toISOString().slice(0, 10) !== date) {
    throw new Error(`Not a real calendar date: "${date}"`);
  }

  return millis / 1000;
}

/** The inclusive window of `days` days that ends at `end` (Unix seconds). */
export function windowBounds(end: number, days: number = WINDOW_DAYS): WindowBounds {
  return { start: end - days * DAY_SECONDS, end };
}

export function isInWindow(endTime: number, bounds: WindowBounds): boolean {
  return endTime >= bounds.start && endTime <= bounds.end;
}

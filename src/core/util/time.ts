// Local-calendar time helpers. "Today", streaks and the daily new-position cap use the browser's
// local midnight; stored times are absolute epoch milliseconds.

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

/** The local midnight at or before `now` (ms). */
export function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** The local calendar day of a time as "YYYY-MM-DD". */
export function dayKey(atMs: number): string {
  const date = new Date(atMs);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The day key `offset` local days from `atMs` (negative = earlier). DST-safe. */
export function shiftDayKey(atMs: number, offset: number): string {
  const date = new Date(atMs);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return dayKey(date.getTime());
}

/** Whole local days from `fromMs` to `toMs` (calendar days, DST-safe; negative if earlier). */
export function daysBetween(fromMs: number, toMs: number): number {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / DAY_MS);
}

const countFormat = new Intl.NumberFormat("en-US");

/** 1380 -> "1,380". */
export function formatCount(value: number): string {
  return countFormat.format(value);
}

/** A short UTC day from Unix seconds, e.g. "Mar 28". */
export function formatDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function formatAgo(atMs: number, nowMs: number = Date.now()): string {
  const minutes = Math.floor((nowMs - atMs) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** 0.395 -> "40%". */
export const pct = (value: number) => `${Math.round(value * 100)}%`;
/** 0.395 -> "39.5%". */
export const pctOne = (value: number) => `${(value * 100).toFixed(1)}%`;

/** A score difference as percentage points with a sign: -9.1, +3.0. */
export function formatDelta(delta: number): string {
  const points = delta * 100;
  return `${points > 0 ? "+" : points < 0 ? "−" : "±"}${Math.abs(points).toFixed(1)}`;
}

/** Points above/below the expectation over all games: -21.2, +9.8. */
export function formatPoints(points: number): string {
  return `${points > 0 ? "+" : points < 0 ? "−" : "±"}${Math.abs(points).toFixed(1)}`;
}

const countFormat = new Intl.NumberFormat("en-GB");

/** 1380 -> "1,380". */
export function formatCount(value: number): string {
  return countFormat.format(value);
}

/** 0.395 -> "40%". */
export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function formatAgo(atMs: number, nowMs: number): string {
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

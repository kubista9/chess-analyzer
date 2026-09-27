import type { GameResult } from "../../shared/types";

export function resultLabel(result: GameResult): string {
  if (result === "win") {
    return "Win";
  }

  if (result === "loss") {
    return "Loss";
  }

  return "Draw";
}

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

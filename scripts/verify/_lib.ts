// Shared helpers for the read-only verify scripts (npx tsx scripts/verify/<name>.ts).
// Nothing here writes to storage/.
import fs from "node:fs";
import path from "node:path";
import { config } from "../../server/config.js";
import { safeKey } from "../../server/store/fileStore.js";
import type { ArchiveGame } from "../../shared/types.js";
import { WINDOW_DAYS, endOfUtcDay, windowBounds, type WindowBounds } from "../../shared/window.js";

export { isInWindow } from "../../shared/window.js";

export const OWNER = "kubista9";

/** Reads `--name value` or `--name=value` from argv. */
export function argValue(name: string, argv: string[] = process.argv.slice(2)): string | undefined {
  const flag = `--${name}`;
  for (const [index, arg] of argv.entries()) {
    if (arg === flag) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} needs a value`);
      }
      return value;
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return undefined;
}

export interface AsofWindow extends WindowBounds {
  asof: string;
  days: number;
}

/**
 * The analysis window for a verify run.
 *
 * `--asof YYYY-MM-DD` means END OF THAT DAY, INCLUSIVE, IN UTC: the window ends at
 * YYYY-MM-DDT23:59:59Z and contains every game with end_time <= that second. It starts
 * `--days` (default WINDOW_DAYS = 183) days earlier, also inclusive:
 * start = end - days * 86400, and a game counts when start <= end_time <= end.
 * Without --asof, today's UTC date is used, so golden numbers should always pass --asof.
 */
export function readAsofWindow(argv: string[] = process.argv.slice(2)): AsofWindow {
  const asof = argValue("asof", argv) ?? new Date().toISOString().slice(0, 10);
  const daysArg = argValue("days", argv);
  const days = daysArg === undefined ? WINDOW_DAYS : Number(daysArg);
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`--days must be a positive integer, got "${daysArg}"`);
  }

  return { asof, days, ...windowBounds(endOfUtcDay(asof), days) };
}

/** The server's converted raw-games cache (storage/cache/raw-games/<user>.json), read-only. */
export function loadRawGames(username: string = OWNER): ArchiveGame[] {
  const filePath = path.join(config.cacheDir, "raw-games", `${safeKey(username)}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`No raw-games cache at ${filePath}. Sync the owner's games in the app first.`);
  }

  const payload = JSON.parse(fs.readFileSync(filePath, "utf8")) as { games?: ArchiveGame[] };
  return payload.games ?? [];
}

export type TableRow = Record<string, string | number | boolean | null | undefined>;

/** Prints rows as an aligned plain-text table; numbers are right-aligned. */
export function printTable(rows: TableRow[], columns: string[] = Object.keys(rows[0] ?? {})): void {
  if (!rows.length) {
    console.log("(no rows)");
    return;
  }

  const cell = (value: TableRow[string]) => (value === null || value === undefined ? "" : String(value));
  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => cell(row[column]).length)));
  const numeric = columns.map((column) => rows.every((row) => typeof row[column] === "number" || row[column] == null));
  const format = (values: string[]) =>
    values
      .map((value, index) => (numeric[index] ? value.padStart(widths[index]) : value.padEnd(widths[index])))
      .join("  ")
      .trimEnd();

  console.log(format(columns));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(format(columns.map((column) => cell(row[column]))));
  }
}

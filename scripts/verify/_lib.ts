// Shared helpers for the read-only verify scripts (npx tsx scripts/verify/<name>.ts).
// Nothing here writes to storage/.
import fs from "node:fs";
import { config } from "../../server/config.js";
import { openDatabase, type Db } from "../../server/db/connection.js";
import { WINDOW_DAYS, endOfUtcDay, windowBounds, type WindowBounds } from "../../shared/window.js";

export { isInWindow } from "../../shared/window.js";

// The one owner, from the app-wide constant (via config, so CHESS_OWNER applies in tests).
export const OWNER = config.owner;

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

/** storage/chess.db, opened read-only (no migrations, no writes). */
export function openStoreReadonly(filePath: string = config.dbPath): Db {
  if (!fs.existsSync(filePath)) {
    throw new Error(`No game store at ${filePath}. Run \`npm run sync\` first.`);
  }
  return openDatabase(filePath, { readonly: true });
}

export interface StoredArchiveMonth {
  month: string;
  url: string;
  etag: string | null;
  fetchedAt: number;
  checkedAt: number;
  lastStatus: number;
  gameCount: number;
  keptCount: number | null;
  skipped: Record<string, number> | null;
  deriveVersion: number | null;
  /** The raw archive entries, exactly as Chess.com returned them. */
  games: Record<string, unknown>[];
}

/** Every stored raw archive month of `username`, oldest first, straight from archive_months. */
export function loadArchiveMonths(db: Db, username: string = OWNER): StoredArchiveMonth[] {
  const rows = db
    .prepare(
      `SELECT month, url, etag, fetched_at, checked_at, last_status, game_count, kept_count, skipped_json,
              derive_version, raw_json
       FROM archive_months WHERE username = ? ORDER BY month`
    )
    .all(username) as {
    month: string;
    url: string;
    etag: string | null;
    fetched_at: number;
    checked_at: number;
    last_status: number;
    game_count: number;
    kept_count: number | null;
    skipped_json: string | null;
    derive_version: number | null;
    raw_json: string;
  }[];

  return rows.map((row) => ({
    month: row.month,
    url: row.url,
    etag: row.etag,
    fetchedAt: row.fetched_at,
    checkedAt: row.checked_at,
    lastStatus: row.last_status,
    gameCount: row.game_count,
    keptCount: row.kept_count,
    skipped: row.skipped_json ? (JSON.parse(row.skipped_json) as Record<string, number>) : null,
    deriveVersion: row.derive_version,
    games: (JSON.parse(row.raw_json) as { games: Record<string, unknown>[] }).games
  }));
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

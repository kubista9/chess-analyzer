import type { SkipCounts } from "../../shared/types.js";
import type { Db } from "./connection.js";

/** Month metadata, without the raw body. */
export interface ArchiveMonthMeta {
  username: string;
  month: string;
  url: string;
  etag: string | null;
  last_modified: string | null;
  fetched_at: number;
  checked_at: number;
  last_status: number;
  game_count: number;
  derive_version: number | null;
  kept_count: number | null;
  skipped_json: string | null;
}

const META_COLUMNS =
  "username, month, url, etag, last_modified, fetched_at, checked_at, last_status, game_count, derive_version, kept_count, skipped_json";

export function getMonthMeta(db: Db, username: string, month: string): ArchiveMonthMeta | undefined {
  return db
    .prepare(`SELECT ${META_COLUMNS} FROM archive_months WHERE username = ? AND month = ?`)
    .get(username, month) as ArchiveMonthMeta | undefined;
}

export function listMonthMeta(db: Db, username: string): ArchiveMonthMeta[] {
  return db
    .prepare(`SELECT ${META_COLUMNS} FROM archive_months WHERE username = ? ORDER BY month`)
    .all(username) as ArchiveMonthMeta[];
}

export function getMonthRaw(db: Db, username: string, month: string): string | undefined {
  const row = db.prepare("SELECT raw_json FROM archive_months WHERE username = ? AND month = ?").get(username, month) as
    | { raw_json: string }
    | undefined;
  return row?.raw_json;
}

export interface FetchedMonth {
  username: string;
  month: string;
  url: string;
  etag: string | null;
  lastModified: string | null;
  at: number;
  gameCount: number;
  rawJson: string;
}

/** Stores a 200 response. The month must be re-derived afterwards (derive_version is reset). */
export function saveFetchedMonth(db: Db, month: FetchedMonth): void {
  db.prepare(
    `INSERT INTO archive_months
       (username, month, url, etag, last_modified, fetched_at, checked_at, last_status, game_count, raw_json,
        derive_version, kept_count, skipped_json)
     VALUES (@username, @month, @url, @etag, @lastModified, @at, @at, 200, @gameCount, @rawJson, NULL, NULL, NULL)
     ON CONFLICT (username, month) DO UPDATE SET
       url = excluded.url, etag = excluded.etag, last_modified = excluded.last_modified,
       fetched_at = excluded.fetched_at, checked_at = excluded.checked_at, last_status = 200,
       game_count = excluded.game_count, raw_json = excluded.raw_json,
       derive_version = NULL, kept_count = NULL, skipped_json = NULL`
  ).run(month);
}

/** A 304: the stored body is still current as of `at`. */
export function markMonthChecked(db: Db, username: string, month: string, at: number, status = 304): void {
  db.prepare("UPDATE archive_months SET checked_at = ?, last_status = ? WHERE username = ? AND month = ?").run(
    at,
    status,
    username,
    month
  );
}

export function markMonthDerived(
  db: Db,
  username: string,
  month: string,
  deriveVersion: number,
  kept: number,
  skipped: SkipCounts
): void {
  db.prepare(
    "UPDATE archive_months SET derive_version = ?, kept_count = ?, skipped_json = ? WHERE username = ? AND month = ?"
  ).run(deriveVersion, kept, JSON.stringify(skipped), username, month);
}

/** Months whose derived games are missing or were derived by another DERIVE_VERSION. */
export function monthsNeedingDerive(db: Db, username: string, deriveVersion: number): string[] {
  return (
    db
      .prepare(
        "SELECT month FROM archive_months WHERE username = ? AND (derive_version IS NULL OR derive_version != ?) ORDER BY month"
      )
      .all(username, deriveVersion) as { month: string }[]
  ).map((row) => row.month);
}

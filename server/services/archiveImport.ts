import { z } from "zod";
import { WINDOW_DAYS, windowBounds } from "../../shared/window.js";
import { config } from "../config.js";
import {
  getMonthMeta,
  getMonthRaw,
  markMonthChecked,
  markMonthDerived,
  monthsNeedingDerive,
  saveFetchedMonth
} from "../db/archiveMonths.js";
import type { Db } from "../db/connection.js";
import { replaceMonthGames } from "../db/games.js";
import { finishSyncRun, startSyncRun } from "../db/syncRuns.js";
import { DERIVE_VERSION, deriveMonth } from "./gameDerive.js";
import { seedFromRawGamesCache } from "./rawGamesSeed.js";
import type { MonthSyncResult, SyncSummary } from "../../shared/types.js";

// Per-month Chess.com archive sync into SQLite.
// - Requests are serial, with REQUEST_GAP_MS between them and config.userAgent.
// - Months intersecting the window are selected; the window is a query filter, not a
//   fetch cap, so older stored months are kept.
// - A closed month (older than the previous month, and last validated more than 48 h
//   after it ended) is never requested again, unless `full` is set.
// - Every other month is revalidated with If-None-Match only. Chess.com's Last-Modified is
//   not RFC-formatted and If-Modified-Since returns 200, so it is stored but never sent.
// - 429: honour Retry-After (or wait 60 s), at most MAX_TRIES tries. 5xx or a network
//   error keeps the stored month and ends the sync with a warning.

export const ARCHIVE_BASE = "https://api.chess.com/pub/player";
export const REQUEST_GAP_MS = 300;
export const MAX_TRIES = 3;
export const DEFAULT_RETRY_MS = 60_000;
export const CLOSED_GRACE_MS = 48 * 3600 * 1000;

export interface ImportDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Milliseconds since the epoch. */
  now: () => number;
  log: (message: string) => void;
}

const defaultDeps: ImportDeps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: (message) => console.log(`[sync] ${message}`)
};

export interface ArchiveRef {
  month: string;
  url: string;
}

export interface SyncProgress {
  /** Months handled so far, of `total` selected months. */
  done: number;
  total: number;
  message: string;
}

export interface SyncOptions {
  /** Revalidate closed months too ("Full re-check"). */
  full?: boolean;
  windowDays?: number;
  deps?: Partial<ImportDeps>;
  /** The offline seed file; defaults to storage/cache/raw-games/<owner>.json. */
  rawGamesPath?: string;
  onProgress?: (progress: SyncProgress) => void;
}

const archiveListSchema = z.object({ archives: z.array(z.string()) });
const archiveMonthSchema = z.object({ games: z.array(z.unknown()) });

export function parseArchiveUrl(url: string): ArchiveRef | null {
  const match = /\/games\/(\d{4})\/(\d{2})\/?$/.exec(url);
  return match ? { month: `${match[1]}-${match[2]}`, url } : null;
}

/** First millisecond of a "YYYY-MM" month, UTC. */
export function monthStartMs(month: string): number {
  const [year, monthIndex] = month.split("-").map(Number);
  return Date.UTC(year, monthIndex - 1, 1);
}

/** First millisecond after a "YYYY-MM" month, UTC. */
export function monthEndMs(month: string): number {
  const [year, monthIndex] = month.split("-").map(Number);
  return Date.UTC(year, monthIndex, 1);
}

export function previousMonth(month: string): string {
  return new Date(monthStartMs(month) - 1).toISOString().slice(0, 7);
}

export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** Listed months that overlap [windowStartSec, now], oldest first. */
export function selectWindowMonths(refs: ArchiveRef[], windowStartSec: number): ArchiveRef[] {
  return refs.filter((ref) => monthEndMs(ref.month) > windowStartSec * 1000).sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * A month is closed when it is older than the previous month and its stored body was
 * last validated (a 200 or a 304) more than 48 h after the month ended.
 */
export function isClosedMonth(month: string, validatedAtMs: number, nowMs: number): boolean {
  return month < previousMonth(monthOf(nowMs)) && validatedAtMs >= monthEndMs(month) + CLOSED_GRACE_MS;
}

export function retryAfterMs(header: string | null, nowMs: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    const date = Date.parse(header);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - nowMs);
    }
  }
  return DEFAULT_RETRY_MS;
}

class Requester {
  requests = 0;

  constructor(private readonly deps: ImportDeps) {}

  /** One serial GET with the polite gap and 429 back-off. Throws on network errors. */
  async get(url: string, headers: Record<string, string> = {}): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      if (this.requests > 0) {
        await this.deps.sleep(REQUEST_GAP_MS);
      }
      this.requests += 1;
      const response = await this.deps.fetch(url, {
        headers: { "User-Agent": config.userAgent, Accept: "application/json", ...headers }
      });
      if (response.status !== 429) {
        return response;
      }
      if (attempt >= MAX_TRIES) {
        throw new Error(`HTTP 429 after ${MAX_TRIES} tries`);
      }
      const wait = retryAfterMs(response.headers.get("retry-after"), this.deps.now());
      this.deps.log(`429 for ${url}; retrying in ${Math.round(wait / 1000)} s`);
      await this.deps.sleep(wait);
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
  }
  return String(error);
}

/** Re-derives every stored month that has no derived games for DERIVE_VERSION. */
export function deriveStaleMonths(db: Db, owner: string): string[] {
  const months = monthsNeedingDerive(db, owner, DERIVE_VERSION);
  for (const month of months) {
    const raw = getMonthRaw(db, owner, month);
    const games = raw ? archiveMonthSchema.parse(JSON.parse(raw)).games : [];
    const derived = deriveMonth(owner, month, games);
    db.transaction(() => {
      replaceMonthGames(db, owner, month, derived.games, "archive");
      markMonthDerived(db, owner, month, DERIVE_VERSION, derived.games.length, derived.skipped);
    })();
  }
  return months;
}

export async function syncArchives(db: Db, owner: string, options: SyncOptions = {}): Promise<SyncSummary> {
  const deps: ImportDeps = { ...defaultDeps, ...options.deps };
  const requester = new Requester(deps);
  const startedAt = deps.now();
  const runId = startSyncRun(db, owner, startedAt);
  const warnings: string[] = [];
  const months: MonthSyncResult[] = [];
  let listedMonths: string[] = [];
  let windowMonths: string[] = [];
  let offline = false;
  let seededMonths: string[] = [];
  let derivedMonths: string[] = [];

  try {
    let refs: ArchiveRef[] | null = null;
    const listUrl = `${ARCHIVE_BASE}/${encodeURIComponent(owner)}/games/archives`;
    try {
      const response = await requester.get(listUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      refs = archiveListSchema
        .parse(await response.json())
        .archives.map(parseArchiveUrl)
        .filter((ref): ref is ArchiveRef => ref !== null);
    } catch (error) {
      offline = true;
      warnings.push(`Could not list the Chess.com archives: ${describeError(error)}. Showing stored games.`);
    }

    if (refs) {
      listedMonths = refs.map((ref) => ref.month).sort();
      const bounds = windowBounds(Math.floor(startedAt / 1000), options.windowDays ?? WINDOW_DAYS);
      const selected = selectWindowMonths(refs, bounds.start);
      windowMonths = selected.map((ref) => ref.month);

      for (const [index, ref] of selected.entries()) {
        options.onProgress?.({ done: index, total: selected.length, message: `Checking ${ref.month}` });
        const stored = getMonthMeta(db, owner, ref.month);
        if (stored && !options.full && isClosedMonth(ref.month, stored.checked_at, deps.now())) {
          months.push({ month: ref.month, outcome: "cached-closed", games: stored.game_count });
          continue;
        }

        try {
          const response = await requester.get(ref.url, stored?.etag ? { "If-None-Match": stored.etag } : {});
          if (response.status === 304 && stored) {
            markMonthChecked(db, owner, ref.month, deps.now());
            months.push({ month: ref.month, outcome: "not-modified", status: 304, games: stored.game_count });
            deps.log(`${ref.month}: 304 not modified`);
          } else if (response.ok) {
            const rawJson = await response.text();
            const games = archiveMonthSchema.parse(JSON.parse(rawJson)).games;
            saveFetchedMonth(db, {
              username: owner,
              month: ref.month,
              url: ref.url,
              etag: response.headers.get("etag"),
              lastModified: response.headers.get("last-modified"),
              at: deps.now(),
              gameCount: games.length,
              rawJson
            });
            months.push({ month: ref.month, outcome: "fetched", status: response.status, games: games.length });
            deps.log(`${ref.month}: ${response.status}, ${games.length} games`);
          } else {
            throw new Error(`HTTP ${response.status}`);
          }
        } catch (error) {
          const message = describeError(error);
          months.push({ month: ref.month, outcome: "error", message });
          warnings.push(`${ref.month}: ${message}; kept the stored month${stored ? "" : " (none stored yet)"}.`);
        }
      }
    } else {
      seededMonths = seedFromRawGamesCache(db, owner, options.rawGamesPath);
      if (seededMonths.length) {
        warnings.push(`Seeded ${seededMonths.join(", ")} from the offline raw-games cache.`);
      }
    }

    options.onProgress?.({ done: windowMonths.length, total: windowMonths.length, message: "Updating the game store" });
    derivedMonths = deriveStaleMonths(db, owner);
  } catch (error) {
    warnings.push(`Sync failed: ${describeError(error)}`);
  }

  const finishedAt = deps.now();
  const summary: SyncSummary = {
    owner,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    ok: warnings.length === 0,
    offline,
    full: options.full ?? false,
    requests: requester.requests,
    listedMonths,
    windowMonths,
    months,
    derivedMonths,
    seededMonths,
    warnings
  };
  finishSyncRun(db, runId, finishedAt, summary.ok, summary);
  return summary;
}

import { WINDOW_DAYS, windowBounds } from "../../shared/window.js";
import { listMonthMeta } from "../db/archiveMonths.js";
import type { Db } from "../db/connection.js";
import { countGames, countGamesByMonth } from "../db/games.js";
import { lastSyncRun } from "../db/syncRuns.js";
import type { ImportStatus, SkipCounts, SyncSummary } from "../../shared/types.js";

/** A sync older than this marks the store as stale. */
export const STALE_AFTER_MS = 24 * 3600 * 1000;

export function buildImportStatus(db: Db, owner: string, nowMs: number = Date.now()): ImportStatus {
  const bounds = windowBounds(Math.floor(nowMs / 1000), WINDOW_DAYS);
  const last = lastSyncRun<SyncSummary>(db, owner);
  const lastOk = lastSyncRun<SyncSummary>(db, owner, true);
  const byMonth = countGamesByMonth(db, owner);
  const stored = new Map<string, Record<string, number>>();
  for (const row of byMonth) {
    const entry = stored.get(row.month) ?? {};
    entry[row.time_class] = (entry[row.time_class] ?? 0) + row.n;
    stored.set(row.month, entry);
  }

  const metas = listMonthMeta(db, owner);
  const archived = new Set(metas.map((meta) => meta.month));

  return {
    owner,
    window: { days: WINDOW_DAYS, ...bounds },
    counts: countGames(db, owner, bounds),
    storedTotal: byMonth.reduce((sum, row) => sum + row.n, 0),
    lastSync:
      last?.summary && last.finishedAt !== null
        ? {
            at: last.finishedAt,
            ok: last.summary.ok,
            offline: last.summary.offline,
            requests: last.summary.requests,
            durationMs: last.summary.durationMs,
            warnings: last.summary.warnings,
            months: last.summary.months
          }
        : null,
    lastSuccessfulSyncAt: lastOk?.finishedAt ?? null,
    stale: !lastOk?.finishedAt || nowMs - lastOk.finishedAt > STALE_AFTER_MS,
    seededMonths: [...new Set(byMonth.filter((row) => row.source === "raw-games-seed").map((row) => row.month))].filter(
      (month) => !archived.has(month)
    ),
    months: metas.map((meta) => ({
      month: meta.month,
      archiveGames: meta.game_count,
      kept: meta.kept_count,
      skipped: meta.skipped_json ? (JSON.parse(meta.skipped_json) as SkipCounts) : null,
      stored: stored.get(meta.month) ?? {},
      lastStatus: meta.last_status,
      fetchedAt: meta.fetched_at,
      checkedAt: meta.checked_at,
      deriveVersion: meta.derive_version
    }))
  };
}

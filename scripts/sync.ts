// npm run sync [-- --full] [-- --offline]
// Syncs kubista9's Chess.com archive months into storage/chess.db and prints a summary.
//   --full     also revalidate closed months (If-None-Match), in case Chess.com amended them
//   --offline  make no requests: seed empty months from storage/cache/raw-games and re-derive
import { config } from "../server/config.js";
import { closeDb, getDb } from "../server/db/connection.js";
import { deriveStaleMonths, syncArchives } from "../server/services/archiveImport.js";
import { buildImportStatus } from "../server/services/importStatus.js";
import { seedFromRawGamesCache } from "../server/services/rawGamesSeed.js";
import { printTable } from "./verify/_lib.js";

const args = new Set(process.argv.slice(2));
const db = getDb();

try {
  if (args.has("--offline")) {
    const seeded = seedFromRawGamesCache(db, config.owner);
    const derived = deriveStaleMonths(db, config.owner);
    console.log(`Offline: seeded ${seeded.length ? seeded.join(", ") : "no months"}; re-derived ${derived.length} month(s).`);
  } else {
    const summary = await syncArchives(db, config.owner, { full: args.has("--full") });
    printTable(
      summary.months.map((month) => ({
        month: month.month,
        outcome: month.outcome,
        status: month.status ?? null,
        games: month.games ?? null,
        message: month.message ?? ""
      }))
    );
    console.log(
      `\n${summary.requests} request(s) in ${(summary.durationMs / 1000).toFixed(1)} s; re-derived ${summary.derivedMonths.length} month(s).`
    );
    for (const warning of summary.warnings) {
      console.warn(`WARNING: ${warning}`);
    }
    process.exitCode = summary.ok ? 0 : 1;
  }

  const status = buildImportStatus(db, config.owner);
  const { counts } = status;
  const day = (seconds: number | null) => (seconds === null ? "-" : new Date(seconds * 1000).toISOString().slice(0, 10));
  console.log(
    `\nWindow (${status.window.days} days): ${counts.total} games, ${counts.byTimeClass.blitz} blitz / ${counts.byTimeClass.rapid} rapid, ` +
      `${counts.byColor.white} White / ${counts.byColor.black} Black, ${day(counts.firstEndTime)} to ${day(counts.lastEndTime)}. ` +
      `${status.storedTotal} games stored in total.`
  );
} finally {
  closeDb();
}

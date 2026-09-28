import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadArchiveSample } from "../../test/loadFixtures.js";
import { deriveMonth } from "../services/gameDerive.js";
import { getMonthMeta, markMonthChecked, monthsNeedingDerive, saveFetchedMonth } from "./archiveMonths.js";
import { openDatabase, type Db } from "./connection.js";
import { countGames, getGame, getGamePlies, listGames, replaceMonthGames } from "./games.js";
import { MIGRATIONS, runMigrations } from "./migrations.js";
import { finishSyncRun, lastSyncRun, startSyncRun } from "./syncRuns.js";

const OWNER = "kubista9";
const opened: Db[] = [];
const tmpDirs: string[] = [];

function memoryDb(): Db {
  const db = openDatabase(":memory:");
  opened.push(db);
  return db;
}

afterEach(() => {
  opened.splice(0).forEach((db) => db.close());
  tmpDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe("migrations", () => {
  it("records each version once and is idempotent", () => {
    const db = memoryDb();
    expect(runMigrations(db)).toEqual([]);
    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(versions).toEqual(MIGRATIONS.map((migration) => ({ version: migration.version })));
  });

  it("creates the P2a tables", () => {
    const db = memoryDb();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (row) => row.name
    );
    expect(tables).toEqual(expect.arrayContaining(["schema_migrations", "archive_months", "games", "game_plies", "sync_runs"]));
  });

  it("uses WAL on a file database and opens it read-only for verify scripts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chess-db-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "nested", "chess.db");
    const db = openDatabase(file);
    opened.push(db);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");

    const readonly = openDatabase(file, { readonly: true });
    opened.push(readonly);
    expect(() => readonly.prepare("DELETE FROM games").run()).toThrow();
    expect(() => openDatabase(path.join(dir, "missing.db"), { readonly: true })).toThrow();
  });
});

describe("archive months", () => {
  it("stores a 200, updates only checked_at on a 304 and resets derivation on a new body", () => {
    const db = memoryDb();
    const month = { username: OWNER, month: "2026-09", url: "u", etag: '"a"', lastModified: "x", at: 1000, gameCount: 7, rawJson: "{}" };
    saveFetchedMonth(db, month);
    expect(monthsNeedingDerive(db, OWNER, 1)).toEqual(["2026-09"]);

    db.prepare("UPDATE archive_months SET derive_version = 1").run();
    markMonthChecked(db, OWNER, "2026-09", 5000);
    expect(getMonthMeta(db, OWNER, "2026-09")).toMatchObject({ fetched_at: 1000, checked_at: 5000, last_status: 304, etag: '"a"' });
    expect(monthsNeedingDerive(db, OWNER, 1)).toEqual([]);
    expect(monthsNeedingDerive(db, OWNER, 2)).toEqual(["2026-09"]);

    saveFetchedMonth(db, { ...month, etag: '"b"', at: 9000 });
    expect(getMonthMeta(db, OWNER, "2026-09")).toMatchObject({ etag: '"b"', fetched_at: 9000, derive_version: null });
  });
});

describe("games", () => {
  const derived = deriveMonth(OWNER, "2026-09", loadArchiveSample().games);

  it("round-trips a GameRecord and its opening plies", () => {
    const db = memoryDb();
    replaceMonthGames(db, OWNER, "2026-09", derived.games, "archive");
    const expected = derived.games[1];
    expect(getGame(db, expected.record.id)).toEqual(expected.record);
    expect(getGamePlies(db, expected.record.id)).toEqual(expected.plies);
  });

  it("replaces a month's games (including seeded ones) and their plies", () => {
    const db = memoryDb();
    replaceMonthGames(db, OWNER, "2026-09", derived.games, "raw-games-seed");
    replaceMonthGames(db, OWNER, "2026-09", derived.games.slice(0, 1), "archive");
    expect(db.prepare("SELECT id, source FROM games").all()).toEqual([{ id: "900000000001", source: "archive" }]);
    expect(db.prepare("SELECT COUNT(DISTINCT game_id) AS n FROM game_plies").get()).toEqual({ n: 1 });
  });

  it("counts by time class and colour inside an inclusive window", () => {
    const db = memoryDb();
    replaceMonthGames(db, OWNER, "2026-09", derived.games, "archive");
    const times = derived.games.map((game) => game.record.endTime).sort();
    const all = countGames(db, OWNER, { start: times[0], end: times.at(-1)! });
    expect(all).toMatchObject({
      total: 3,
      byTimeClass: { blitz: 2, rapid: 1 },
      byColor: { white: 2, black: 1 },
      firstEndTime: times[0],
      lastEndTime: times.at(-1)
    });
    expect(countGames(db, OWNER, { start: times[0] + 1, end: times.at(-1)! }).total).toBe(2);
    expect(listGames(db, OWNER, { start: 0, end: Number.MAX_SAFE_INTEGER }).map((game) => game.endTime)).toEqual(
      [...times].reverse()
    );
  });
});

describe("sync runs", () => {
  it("returns the latest finished run, optionally only successful ones", () => {
    const db = memoryDb();
    finishSyncRun(db, startSyncRun(db, OWNER, 1), 2, true, { n: 1 });
    finishSyncRun(db, startSyncRun(db, OWNER, 3), 4, false, { n: 2 });
    startSyncRun(db, OWNER, 5);
    expect(lastSyncRun(db, OWNER)).toMatchObject({ finishedAt: 4, ok: false, summary: { n: 2 } });
    expect(lastSyncRun(db, OWNER, true)).toMatchObject({ finishedAt: 2, ok: true, summary: { n: 1 } });
  });
});

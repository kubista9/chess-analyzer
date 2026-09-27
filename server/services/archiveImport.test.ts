import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asArchiveGame, loadArchiveSample, type RawChessComGame } from "../../test/loadFixtures.js";
import { getMonthMeta } from "../db/archiveMonths.js";
import { openDatabase, type Db } from "../db/connection.js";
import { countGames } from "../db/games.js";
import {
  ARCHIVE_BASE,
  DEFAULT_RETRY_MS,
  REQUEST_GAP_MS,
  deriveStaleMonths,
  isClosedMonth,
  monthEndMs,
  previousMonth,
  retryAfterMs,
  selectWindowMonths,
  syncArchives,
  syncOnce,
  type ImportDeps
} from "./archiveImport.js";
import { DERIVE_VERSION } from "./gameDerive.js";
import { buildImportStatus } from "./importStatus.js";

const OWNER = "kubista9";
const NOW = Date.parse("2026-09-26T12:00:00Z");
const LISTED = ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
const WINDOW = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
const monthUrl = (month: string) => `${ARCHIVE_BASE}/${OWNER}/games/${month.replace("-", "/")}`;
const LIST_URL = `${ARCHIVE_BASE}/${OWNER}/games/archives`;

/** The synthetic 7-entry month, moved into `month` with month-unique ids (3 kept per month). */
function monthGames(month: string): RawChessComGame[] {
  const start = Date.parse(`${month}-10T12:00:00Z`) / 1000;
  const monthKey = month.replace("-", "");
  return loadArchiveSample().games.map((game, index) => {
    const id = `${monthKey}${game.url.split("/").at(-1)}`;
    return {
      ...game,
      url: game.url.replace(/\d+$/, id),
      uuid: `${monthKey}-${game.uuid}`,
      end_time: start + index
    };
  });
}

type Handler = (url: string, headers: Record<string, string>) => Response | Promise<Response>;

/** A fake api.chess.com: ETag = "<month>-v<version>", 304 on a matching If-None-Match. */
function fakeChessCom(overrides: Record<string, Handler> = {}) {
  const versions = new Map<string, number>();
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    if (overrides[url]) {
      return overrides[url](url, headers);
    }
    if (url === LIST_URL) {
      return Response.json({ archives: LISTED.map(monthUrl) });
    }
    const month = LISTED.find((candidate) => monthUrl(candidate) === url);
    if (!month) {
      return new Response("not found", { status: 404 });
    }
    const etag = `"${month}-v${versions.get(month) ?? 1}"`;
    if (headers["If-None-Match"] === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(JSON.stringify({ games: monthGames(month) }), {
      status: 200,
      headers: { etag, "last-modified": "Sat, 26 Sep 2026 10:00:00 +0000", "content-type": "application/json" }
    });
  });
  return { fetchMock, calls, bump: (month: string) => versions.set(month, (versions.get(month) ?? 1) + 1) };
}

function deps(fetchMock: ImportDeps["fetch"], now = NOW) {
  const sleep = vi.fn(async (_ms: number) => undefined);
  return { sleep, deps: { fetch: fetchMock, sleep, now: () => now, log: () => undefined } satisfies ImportDeps };
}

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

describe("month helpers", () => {
  it("selects the listed months that overlap the window, oldest first", () => {
    const refs = [...LISTED].reverse().map((month) => ({ month, url: monthUrl(month) }));
    const windowStart = Math.floor(NOW / 1000) - 183 * 86_400; // 2026-03-27
    expect(selectWindowMonths(refs, windowStart).map((ref) => ref.month)).toEqual(WINDOW);
  });

  it("closes a month only when it is older than the previous month and validated 48 h after its end", () => {
    const julyEnd = monthEndMs("2026-07");
    expect(previousMonth("2026-01")).toBe("2025-12");
    expect(isClosedMonth("2026-07", julyEnd + 49 * 3600_000, NOW)).toBe(true);
    expect(isClosedMonth("2026-07", julyEnd + 47 * 3600_000, NOW)).toBe(false);
    expect(isClosedMonth("2026-08", NOW, NOW)).toBe(false); // previous month
    expect(isClosedMonth("2026-09", NOW, NOW)).toBe(false); // current month
  });

  it("reads Retry-After as seconds or a date, else waits 60 s", () => {
    expect(retryAfterMs("2", NOW)).toBe(2000);
    expect(retryAfterMs(new Date(NOW + 5000).toUTCString(), NOW)).toBe(5000);
    expect(retryAfterMs(null, NOW)).toBe(DEFAULT_RETRY_MS);
  });
});

describe("syncArchives", () => {
  it("first sync: lists, then fetches every window month serially with the polite gap", async () => {
    const db = memoryDb();
    const server = fakeChessCom();
    const { deps: d, sleep } = deps(server.fetchMock);
    const summary = await syncArchives(db, OWNER, { deps: d });

    expect(server.calls.map((call) => call.url)).toEqual([LIST_URL, ...WINDOW.map(monthUrl)]);
    expect(server.calls.every((call) => call.headers["User-Agent"]?.length > 0)).toBe(true);
    expect(server.calls.some((call) => "If-Modified-Since" in call.headers)).toBe(false);
    expect(sleep.mock.calls).toEqual(Array(WINDOW.length).fill([REQUEST_GAP_MS]));
    expect(summary).toMatchObject({ ok: true, offline: false, requests: 8, windowMonths: WINDOW, derivedMonths: WINDOW });
    expect(summary.listedMonths).toEqual(LISTED);
    expect(summary.months.every((month) => month.outcome === "fetched" && month.games === 7)).toBe(true);

    for (const month of WINDOW) {
      expect(getMonthMeta(db, OWNER, month)).toMatchObject({
        etag: `"${month}-v1"`,
        game_count: 7,
        kept_count: 3,
        derive_version: DERIVE_VERSION,
        last_status: 200
      });
    }
    expect(countGames(db, OWNER, { start: 0, end: Number.MAX_SAFE_INTEGER })).toMatchObject({
      total: 21,
      byTimeClass: { blitz: 14, rapid: 7 }
    });
  });

  it("second sync: closed months are not requested; current and previous get If-None-Match and a 304", async () => {
    const db = memoryDb();
    const server = fakeChessCom();
    await syncArchives(db, OWNER, { deps: deps(server.fetchMock).deps });
    server.calls.length = 0;

    const later = NOW + 3600_000;
    const summary = await syncArchives(db, OWNER, { deps: deps(server.fetchMock, later).deps });
    expect(server.calls).toEqual([
      { url: LIST_URL, headers: expect.not.objectContaining({ "If-None-Match": expect.anything() }) },
      { url: monthUrl("2026-08"), headers: expect.objectContaining({ "If-None-Match": '"2026-08-v1"' }) },
      { url: monthUrl("2026-09"), headers: expect.objectContaining({ "If-None-Match": '"2026-09-v1"' }) }
    ]);
    expect(summary.requests).toBe(3);
    expect(summary.derivedMonths).toEqual([]);
    expect(summary.months.filter((month) => month.outcome === "cached-closed").map((month) => month.month)).toEqual(WINDOW.slice(0, 5));
    expect(getMonthMeta(db, OWNER, "2026-09")).toMatchObject({ last_status: 304, fetched_at: NOW, checked_at: later });
  });

  it("re-derives a month whose body changed (200 after a new ETag)", async () => {
    const db = memoryDb();
    const server = fakeChessCom();
    await syncArchives(db, OWNER, { deps: deps(server.fetchMock).deps });
    server.bump("2026-09");
    const summary = await syncArchives(db, OWNER, { deps: deps(server.fetchMock, NOW + 60_000).deps });
    expect(summary.derivedMonths).toEqual(["2026-09"]);
    expect(getMonthMeta(db, OWNER, "2026-09")).toMatchObject({ etag: '"2026-09-v2"', last_status: 200 });
  });

  it("full re-check revalidates closed months too", async () => {
    const db = memoryDb();
    const server = fakeChessCom();
    await syncArchives(db, OWNER, { deps: deps(server.fetchMock).deps });
    server.calls.length = 0;
    const summary = await syncArchives(db, OWNER, { full: true, deps: deps(server.fetchMock, NOW + 3600_000).deps });
    expect(summary.requests).toBe(1 + WINDOW.length);
    expect(summary.months.every((month) => month.outcome === "not-modified")).toBe(true);
  });

  it("honours Retry-After on a 429 and then succeeds", async () => {
    const db = memoryDb();
    let throttled = 0;
    const server = fakeChessCom({
      [monthUrl("2026-05")]: () => {
        throttled += 1;
        return throttled === 1
          ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
          : Response.json({ games: monthGames("2026-05") });
      }
    });
    const { deps: d, sleep } = deps(server.fetchMock);
    const summary = await syncArchives(db, OWNER, { deps: d });
    expect(throttled).toBe(2);
    expect(sleep.mock.calls.map(([ms]) => ms)).toContain(2000);
    expect(summary.ok).toBe(true);
    expect(getMonthMeta(db, OWNER, "2026-05")?.kept_count).toBe(3);
  });

  it("gives up after 3 tries on repeated 429s, waiting 60 s without Retry-After, and keeps going", async () => {
    const db = memoryDb();
    const server = fakeChessCom({ [monthUrl("2026-05")]: () => new Response("", { status: 429 }) });
    const { deps: d, sleep } = deps(server.fetchMock);
    const summary = await syncArchives(db, OWNER, { deps: d });
    expect(server.calls.filter((call) => call.url === monthUrl("2026-05"))).toHaveLength(3);
    expect(sleep.mock.calls.filter(([ms]) => ms === DEFAULT_RETRY_MS)).toHaveLength(2);
    expect(summary.ok).toBe(false);
    expect(summary.warnings.join("\n")).toContain("2026-05: HTTP 429 after 3 tries");
    expect(summary.months.find((month) => month.month === "2026-06")?.outcome).toBe("fetched");
  });

  it("keeps the stored month on a 5xx and reports a warning", async () => {
    const db = memoryDb();
    const server = fakeChessCom();
    await syncArchives(db, OWNER, { deps: deps(server.fetchMock).deps });
    const failing = fakeChessCom({ [monthUrl("2026-09")]: () => new Response("oops", { status: 503 }) });
    const summary = await syncArchives(db, OWNER, { deps: deps(failing.fetchMock, NOW + 60_000).deps });
    expect(summary.ok).toBe(false);
    expect(summary.warnings[0]).toMatch(/2026-09: HTTP 503; kept the stored month/);
    expect(getMonthMeta(db, OWNER, "2026-09")).toMatchObject({ kept_count: 3, last_status: 200 });
  });

  it("offline: warns, seeds empty months from the raw-games cache, and a later online sync replaces them", async () => {
    const db = memoryDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-games-"));
    tmpDirs.push(dir);
    const rawGamesPath = path.join(dir, "kubista9.json");
    const seedGames = monthGames("2026-09").map((game) => asArchiveGame(game, game.time_class as "blitz"));
    fs.writeFileSync(rawGamesPath, JSON.stringify({ createdAt: "x", games: seedGames }));

    const down = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.chess.com") });
    });
    const offline = await syncArchives(db, OWNER, { deps: deps(down).deps, rawGamesPath });
    expect(offline).toMatchObject({ ok: false, offline: true, seededMonths: ["2026-09"], requests: 1 });
    expect(offline.warnings[0]).toContain("ENOTFOUND");
    expect(buildImportStatus(db, OWNER, NOW)).toMatchObject({ seededMonths: ["2026-09"], counts: { total: 3 } });
    expect(db.prepare("SELECT DISTINCT source FROM games").all()).toEqual([{ source: "raw-games-seed" }]);

    await syncArchives(db, OWNER, { deps: deps(fakeChessCom().fetchMock).deps, rawGamesPath });
    expect(db.prepare("SELECT DISTINCT source FROM games").all()).toEqual([{ source: "archive" }]);
    // The window (from 2026-03-27) excludes the synthetic March games, which end on 03-10.
    expect(buildImportStatus(db, OWNER, NOW)).toMatchObject({ seededMonths: [], counts: { total: 18 }, storedTotal: 21 });
  });

  it("keeps stored months that have left the window", async () => {
    const db = memoryDb();
    const server = fakeChessCom();
    await syncArchives(db, OWNER, { deps: deps(server.fetchMock).deps });
    const inDecember = Date.parse("2026-12-15T00:00:00Z");
    await syncArchives(db, OWNER, { deps: deps(server.fetchMock, inDecember).deps });
    expect(getMonthMeta(db, OWNER, "2026-03")?.kept_count).toBe(3);
  });

  it("re-derives stale months from raw_json without the network", async () => {
    const db = memoryDb();
    await syncArchives(db, OWNER, { deps: deps(fakeChessCom().fetchMock).deps });
    db.prepare("UPDATE archive_months SET derive_version = 0 WHERE month = '2026-04'").run();
    db.prepare("DELETE FROM games WHERE month = '2026-04'").run();
    expect(deriveStaleMonths(db, OWNER)).toEqual(["2026-04"]);
    expect(getMonthMeta(db, OWNER, "2026-04")).toMatchObject({ kept_count: 3, derive_version: DERIVE_VERSION });
    expect(countGames(db, OWNER, { start: 0, end: Number.MAX_SAFE_INTEGER }).total).toBe(21);
  });

  it("records the run for GET /api/status", async () => {
    const db = memoryDb();
    await syncArchives(db, OWNER, { deps: deps(fakeChessCom().fetchMock).deps });
    const status = buildImportStatus(db, OWNER, NOW + 1000);
    expect(status).toMatchObject({
      stale: false,
      lastSync: { at: NOW, ok: true, requests: 8 },
      // Window from 2026-03-27: April to September, 3 kept games each (the March games end on 03-10).
      counts: { total: 18, byTimeClass: { blitz: 12, rapid: 6 }, byColor: { white: 12, black: 6 } },
      storedTotal: 21
    });
    expect(status.months).toHaveLength(WINDOW.length);
    expect(status.months[0]).toMatchObject({ month: "2026-03", archiveGames: 7, kept: 3, skipped: { variant: 1, "time-class": 2, duplicate: 1 } });
    expect(buildImportStatus(db, OWNER, NOW + 25 * 3600_000).stale).toBe(true);
  });
});

describe("syncOnce", () => {
  it("joins a running sync instead of starting a second one", async () => {
    const db = memoryDb();
    const server = fakeChessCom();
    const options = { deps: deps(server.fetchMock).deps };
    const first = syncOnce(db, OWNER, options);
    const second = syncOnce(db, OWNER, options);
    expect(second).toBe(first);
    await first;
    expect(server.calls.filter((call) => call.url === LIST_URL)).toHaveLength(1);
  });
});

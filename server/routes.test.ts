import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { START_EPD } from "../shared/epd.js";
import type { FixListResponse, JobState, SnapshotResponse, SyncSummary, TreeGamesResponse, TreeResponse } from "../shared/types.js";
import { loadOwnerGames } from "../test/loadFixtures.js";
import { createApp } from "./app.js";
import { openDatabase, type Db } from "./db/connection.js";
import { getGamePlies, replaceMonthGames } from "./db/games.js";
import { createApiRouter } from "./routes.js";
import { deriveMonth, utcMonth } from "./services/gameDerive.js";
import { getOpeningBook } from "./services/openingBook.js";
import { JobStore } from "./store/jobStore.js";

const OWNER = "kubista9";
const NOW = Date.parse("2026-09-27T00:00:00Z");

/** An in-memory store holding the owner's 8 real fixture games (2026-04-22 .. 2026-09-26). */
function storeWithOwnerGames(): Db {
  const db = openDatabase(":memory:");
  const byMonth = new Map<string, unknown[]>();
  for (const game of loadOwnerGames()) {
    const month = utcMonth(game.end_time);
    byMonth.set(month, [...(byMonth.get(month) ?? []), game]);
  }
  for (const [month, games] of byMonth) {
    replaceMonthGames(db, OWNER, month, deriveMonth(OWNER, month, games).games, "archive");
  }
  return db;
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

async function startApi(sync: () => Promise<SyncSummary> = () => new Promise(() => {})) {
  const db = storeWithOwnerGames();
  const jobs = new JobStore();
  const router = createApiRouter({ db: () => db, jobs, owner: OWNER, now: () => NOW, sync, book: getOpeningBook });
  const server = createApp(router).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async <T>(path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json" }
    });
    // Unknown routes answer Express's HTML 404, not JSON.
    const text = await response.text();
    return { status: response.status, body: (text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text) as T };
  };
  return { call, jobs, db };
}

describe("jobs API", () => {
  it("answers 404, not 500, for an unknown job", async () => {
    const { call } = await startApi();
    const { status, body } = await call<{ error: string }>("/jobs/0f8c1c0e-no-such-job");
    expect(status).toBe(404);
    expect(body.error).toMatch(/Unknown job/);
  });

  it("gives two quick Sync requests one job, listed as active", async () => {
    let runs = 0;
    const { call } = await startApi(() => {
      runs += 1;
      return new Promise(() => {});
    });
    const post = () => call<JobState<unknown>>("/sync", { method: "POST", body: "{}" });
    const [first, second] = await Promise.all([post(), post()]);
    expect(first.status).toBe(202);
    expect(second.body.id).toBe(first.body.id);
    expect(first.body).toMatchObject({ key: "sync", type: "sync" });

    const active = await call<JobState<unknown>[]>("/jobs/active");
    expect(active.body.map((job) => job.id)).toEqual([first.body.id]);
    expect(runs).toBe(1);
  });

  it("finishes a failed sync with its reason", async () => {
    const { call } = await startApi(async () => {
      throw new Error("database is locked");
    });
    const started = await call<JobState<unknown>>("/sync", { method: "POST", body: "{}" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const { body } = await call<JobState<unknown>>(`/jobs/${started.body.id}`);
    expect(body).toMatchObject({ status: "failed", error: "database is locked" });
  });

  it("answers 404 for a review of a game that is not stored", async () => {
    const { call } = await startApi();
    const { status } = await call("/game-review", { method: "POST", body: JSON.stringify({ gameId: "123" }) });
    expect(status).toBe(404);
  });
});

describe("games API", () => {
  it("opens a stored game by id and 404s an unknown one", async () => {
    const { call } = await startApi();
    const found = await call<{ game: { id: string; color: string } }>("/games/184405952510");
    expect(found.body.game).toMatchObject({ id: "184405952510", color: "black" });
    expect((await call("/games/1")).status).toBe(404);
  });

  it("no longer serves the removed game list and name-based report", async () => {
    const { call } = await startApi();
    expect((await call("/games")).status).toBe(404);
    expect((await call("/openings/report")).status).toBe(404);
  });
});

describe("tree API", () => {
  const tree = (query: string) => startApi().then(({ call }) => call<TreeResponse & { error?: string }>(`/tree?${query}`));
  const epdQuery = (epd: string) => `epd=${encodeURIComponent(epd)}`;

  it("returns the start node of one colour with its move rows", async () => {
    const { status, body } = await tree("color=white");
    expect(status).toBe(200);
    expect(body).toMatchObject({ color: "white", timeClass: null, halfLifeDays: 90, maxPly: 20, games: 4, path: [] });
    expect(body.window).toMatchObject({ key: "6m", days: 183 });
    expect(body.node).toMatchObject({ epd: START_EPD, n: 4, ownerToMove: true, inBook: true });
    expect(body.node.edges.reduce((sum, edge) => sum + edge.n, 0)).toBe(4);
    const first = body.node.edges[0];
    expect(first).toMatchObject({ owner: true, name: expect.any(String), inBook: true });
    // Game ids stay on the server; GET /tree/games pages them.
    expect(first).not.toHaveProperty("gameIds");
    expect(first.weighted.wN).toBeLessThan(first.n);
  });

  it("descends by EPD and by moves, and merges the fixture's transposition pair", async () => {
    const { call, db } = await startApi();
    const plies = getGamePlies(db, "174004846670").slice(0, 8);
    // Both transposition games (1.c4) meet at ply 8, but not before.
    const seen: number[] = [];
    for (const ply of plies) {
      const byEpd = (await call<TreeResponse>(`/tree?color=white&hl=off&${epdQuery(ply.epdAfter)}`)).body;
      seen.push(byEpd.node.n);
    }
    expect(seen.at(-1)).toBe(2);
    expect(seen.at(-2)).toBe(1);

    const moves = plies.map((ply) => ply.uci).join(",");
    const { status, body } = await call<TreeResponse>(`/tree?color=white&hl=off&moves=${moves}`);
    expect(status).toBe(200);
    expect(body.halfLifeDays).toBeNull();
    expect(body.node).toMatchObject({ epd: plies[7].epdAfter, ply: 8, n: 2 });
    expect(body.path.map((step) => step.san)).toEqual(plies.map((ply) => ply.san));
    expect(body.path.map((step) => step.ply)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(body.path[0]).toMatchObject({ uci: plies[0].uci, epd: plies[0].epdAfter, n: expect.any(Number) });
    expect(body.path.at(-1)!.n).toBe(1);
    expect(body.path[0].name).toMatch(/English/);

    const start = await call<TreeResponse>("/tree?color=white&moves=");
    expect(start.body).toMatchObject({ node: { epd: START_EPD }, path: [] });
  });

  it("pages the games behind a move, newest first, with the ply it was played at", async () => {
    const { call, db } = await startApi();
    const root = (await call<TreeResponse>("/tree?color=black")).body.node;
    const edge = root.edges[0];
    const { status, body } = await call<TreeGamesResponse>(`/tree/games?color=black&uci=${edge.uci}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ color: "black", epd: START_EPD, uci: edge.uci, san: edge.san, total: edge.n, page: 1, pages: 1 });
    expect(body.games).toHaveLength(edge.n);
    expect(body.games.map((game) => game.endTime)).toEqual([...body.games.map((game) => game.endTime)].sort((a, b) => b - a));
    expect(body.games.every((game) => game.ply === 1 && game.url.startsWith("https://www.chess.com/"))).toBe(true);

    // Deeper: the second ply of the newest game is played at ply 2.
    const newest = getGamePlies(db, body.games[0].id);
    const second = await call<TreeGamesResponse>(`/tree/games?color=black&moves=${newest[0].uci}&uci=${newest[1].uci}&size=1`);
    expect(second.body).toMatchObject({ epd: newest[0].epdAfter, page: 1, pageSize: 1 });
    expect(second.body.games[0]).toMatchObject({ id: body.games[0].id, ply: 2 });
    expect(second.body.pages).toBe(second.body.total);

    // Past the last page clamps to it; a move nobody played is a 404.
    const last = await call<TreeGamesResponse>(`/tree/games?color=black&uci=${edge.uci}&size=1&page=99`);
    expect(last.body.page).toBe(edge.n);
    expect(last.body.games).toHaveLength(1);
    expect((await call(`/tree/games?color=black&uci=a2a3`)).status).toBe(404);
    expect((await call(`/tree/games?color=black`)).status).toBe(400);
  });

  it("applies the window, time class and half-life filters", async () => {
    const { call } = await startApi();
    expect((await call<TreeResponse>("/tree?color=black&window=3m")).body).toMatchObject({ halfLifeDays: null, games: 2 });
    expect((await call<TreeResponse>("/tree?color=black&hl=60")).body).toMatchObject({ halfLifeDays: 60, games: 4 });
    const rapid = await call<TreeResponse>("/tree?color=black&tc=rapid");
    expect(rapid.status).toBe(200);
    expect(rapid.body).toMatchObject({ timeClass: "rapid", games: 0 });
    expect(rapid.body.node).toMatchObject({ n: 0, edges: [] });
  });

  it("rejects bad parameters and 404s a position the games never reached", async () => {
    const { call } = await startApi();
    expect((await call("/tree")).status).toBe(400);
    expect((await call("/tree?color=red")).status).toBe(400);
    expect((await call("/tree?color=white&epd=not-an-epd")).status).toBe(400);
    expect((await call("/tree?color=white&hl=-1")).status).toBe(400);
    expect((await call("/tree?color=white&window=12m")).status).toBe(400);
    expect((await call("/tree?color=white&moves=e4")).status).toBe(400);
    expect((await call(`/tree?color=white&moves=e2e4&${epdQuery(START_EPD)}`)).status).toBe(400);
    const unplayed = await call<{ error: string }>("/tree?color=white&moves=h2h4");
    expect(unplayed.status).toBe(404);
    expect(unplayed.body.error).toMatch(/never played h2h4 after 0 moves/);
    const unreached = await call<{ error: string }>(`/tree?color=white&${epdQuery("8/8/8/8/8/8/8/K6k w - -")}`);
    expect(unreached.status).toBe(404);
    expect(unreached.body.error).toMatch(/never reached/);
  });
});

describe("fix list and snapshot API", () => {
  it("answers the fix list over both colours with its scope and thresholds", async () => {
    const { call } = await startApi();
    const { status, body } = await call<FixListResponse>("/fixlist");
    expect(status).toBe(200);
    // 8 fixture games: no line reaches 8 games, so nothing is tested or listed.
    expect(body).toMatchObject({ halfLifeDays: 90, timeClass: null, maxPly: 20, tested: 0, significant: 0, items: [], watch: [] });
    expect(body.games.white + body.games.black).toBe(8);
    expect(body.window.key).toBe("6m");
    expect(body.thresholds).toEqual({ minN: 8, minEss: 8, minZ: 1.64, fdrQ: 0.2, minPoints: 1, earlyLossPly: 40 });
    // Memoised: a second request answers the same list.
    expect((await call<FixListResponse>("/fixlist")).body).toEqual(body);
    expect((await call<FixListResponse>("/fixlist?window=3m&tc=blitz")).body).toMatchObject({ halfLifeDays: null, timeClass: "blitz" });
  });

  it("answers the repertoire snapshot per colour", async () => {
    const { call } = await startApi();
    const { status, body } = await call<SnapshotResponse>("/snapshot?hl=off");
    expect(status).toBe(200);
    expect(body.halfLifeDays).toBeNull();
    expect(body.white).toMatchObject({ color: "white", games: body.games.white });
    expect(body.black).toMatchObject({ color: "black", games: body.games.black });
    // As White the owner's first moves come first, whatever the sample.
    expect(body.white.groups[0]).toMatchObject({ label: "First move", moves: [] });
    expect(body.white.groups[0].answers[0].label).toMatch(/^1\./);
  });

  it("rejects bad filters", async () => {
    const { call } = await startApi();
    expect((await call("/fixlist?window=12m")).status).toBe(400);
    expect((await call("/fixlist?tc=bullet")).status).toBe(400);
    expect((await call("/snapshot?hl=-5")).status).toBe(400);
  });
});

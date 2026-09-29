import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { START_EPD } from "../shared/epd.js";
import type {
  AnalysisStatus,
  FixListResponse,
  JobState,
  PowerState,
  RepertoireCoverageResponse,
  RepertoireResponse,
  SeedResponse,
  SnapshotResponse,
  SyncSummary,
  TreeGamesResponse,
  TreeResponse
} from "../shared/types.js";
import { Chess } from "chess.js";
import type { GameAnalysisResponse, OpeningReview, RetryResult } from "../shared/review.js";
import type { RepEntry } from "../shared/repertoire.js";
import type { AlternativesResponse } from "../shared/alternatives.js";
import type { DrillAnswerResponse, DrillSessionResponse, DrillStats, LineRunItem, MistakeItem } from "../shared/training/api.js";
import { getDeepEval } from "./db/positions.js";
import { legalFakePool } from "../test/fakeEngine.js";
import { loadOwnerGames } from "../test/loadFixtures.js";
import { createApp } from "./app.js";
import { openDatabase, type Db } from "./db/connection.js";
import { getGamePlies, replaceMonthGames } from "./db/games.js";
import { upsertRepEntry } from "./db/repertoire.js";
import { entry } from "../test/trainingFixtures.js";
import { createApiRouter } from "./routes.js";
import { deriveMonth, utcMonth } from "./services/gameDerive.js";
import { getOpeningBook } from "./services/openingBook.js";
import { JobStore } from "./store/jobStore.js";
import { currentEngineConfig } from "./engine/engineConfig.js";
import type { EnginePool } from "./engine/pool.js";
import { BackfillService } from "./services/backfillService.js";

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

const pools: EnginePool[] = [];
const lockDirs: string[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  lockDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

async function startApi(sync: () => Promise<SyncSummary> = () => new Promise(() => {}), options: { power?: PowerState | null } = {}) {
  const db = storeWithOwnerGames();
  const jobs = new JobStore();
  const fake = legalFakePool({ size: 2 });
  pools.push(fake.pool);
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "chess-routes-"));
  lockDirs.push(lockDir);
  const engineConfig = async (store: Db) => currentEngineConfig(store, "Stockfish 18");
  const backfill = new BackfillService({
    db: () => db,
    pool: () => fake.pool,
    owner: OWNER,
    lockPath: path.join(lockDir, "backfill.lock"),
    engineConfig,
    power: () => options.power ?? null,
    autoBackfill: false,
    now: () => NOW
  });
  const router = createApiRouter({
    db: () => db,
    jobs,
    owner: OWNER,
    now: () => NOW,
    sync,
    book: getOpeningBook,
    backfill,
    pool: () => fake.pool,
    engineConfig
  });
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
    const json = response.headers.get("content-type")?.includes("json") ?? false;
    return { status: response.status, body: (json ? JSON.parse(text) : text) as T };
  };
  return { call, jobs, db, backfill, log: fake.log };
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
    const { status } = await call("/games/123/analysis");
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
    expect(body.thresholds).toEqual({
      minN: 8,
      minEss: 8,
      minZ: 1.64,
      fdrQ: 0.2,
      minPoints: 1,
      earlyLossPly: 40,
      hole: { minN: 3, minLoss: 7, replyLoss: 5, replyCp: 100 },
      engine: { minGames: 5, minCoverage: 0.5 }
    });
    // No position is analysed yet: engine data for 0 games, and no engine claim is shown.
    expect(body).toMatchObject({ holes: 0, cap: 10, engine: { white: { complete: 0 }, black: { complete: 0 } } });
    expect(body.engine!.black.firstErrorShares.every((share) => !share.shown && share.known === 0)).toBe(true);
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

describe("engine check API", () => {
  it("reports the queue and coverage, asks before running on battery, and runs the backfill", async () => {
    const { call, backfill } = await startApi(undefined, { power: { onBattery: true, percent: 50, lowPowerMode: false } });
    const before = await call<AnalysisStatus>("/analysis/status");
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      engine: { idName: "Stockfish 18", configId: 1 },
      state: "idle",
      runner: null,
      games: { total: 8, analysed: 0, queued: 8 },
      positions: { cached: 0 },
      estimate: { measured: false },
      power: { onBattery: true }
    });
    expect(before.body.positions.total).toBeGreaterThan(100);

    const refused = await call<{ error: string; code: string }>("/analysis/backfill", { method: "POST", body: "{}" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "on-battery" });
    expect(refused.body.error).toMatch(/on battery \(50%\)/);

    const started = await call<AnalysisStatus>("/analysis/backfill", { method: "POST", body: JSON.stringify({ allowBattery: true }) });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ state: "running", runner: { source: "server" } });
    await backfill.idle();

    const after = await call<AnalysisStatus>("/analysis/status");
    expect(after.body).toMatchObject({
      state: "idle",
      runner: null,
      games: { analysed: 8, queued: 0, byColor: { white: { analysed: after.body.games.byColor.white.total } } },
      lastRun: { status: "completed", gamesDone: 8, source: "server" },
      progress: { pass: "done", games: { done: 8 } }
    });
    expect(after.body.positions.cached).toBe(after.body.positions.total);
  });

  it("pauses between games and resumes on the next start", async () => {
    const { call, backfill } = await startApi();
    await call("/analysis/backfill", { method: "POST", body: "{}" });
    const pausing = await call<AnalysisStatus>("/analysis/pause", { method: "POST", body: "{}" });
    expect(pausing.body.state).toBe("pausing");
    await backfill.idle();
    const paused = await call<AnalysisStatus>("/analysis/status");
    expect(paused.body.state).toBe("paused");
    expect(paused.body.games.queued).toBeGreaterThan(0);

    await call("/analysis/backfill", { method: "POST", body: "{}" });
    await backfill.idle();
    expect((await call<AnalysisStatus>("/analysis/status")).body).toMatchObject({ state: "idle", games: { queued: 0 } });
  });

  it("serves a backfilled game's review at once from the position cache, with no engine search", async () => {
    const { call, backfill, log, db } = await startApi();
    await call("/analysis/backfill", { method: "POST", body: "{}" });
    await backfill.idle();
    const searches = log.length;
    const [{ id }] = db.prepare("SELECT id FROM games ORDER BY end_time DESC LIMIT 1").all() as { id: string }[];

    const review = await call<GameAnalysisResponse>(`/games/${id}/analysis`);
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({ job: null, engineError: null, review: { gameId: id, status: "complete" } });
    expect(review.body.review.plies).toHaveLength(20);
    expect(review.body.review.plies.every((ply) => ply.lines.length && ply.played && ply.evalAfter !== "pending")).toBe(true);
    expect(log).toHaveLength(searches);
  });

  it("judges a Retry move from the cache, scores an unknown move on demand, and refuses opponent plies", async () => {
    const { call, backfill, log, db } = await startApi();
    await call("/analysis/backfill", { method: "POST", body: "{}" });
    await backfill.idle();
    const [{ id }] = db.prepare("SELECT id FROM games ORDER BY end_time DESC LIMIT 1").all() as { id: string }[];
    const { review } = (await call<GameAnalysisResponse>(`/games/${id}/analysis`)).body;
    const mine = review.plies.find((ply) => ply.owner)!;
    const theirs = review.plies.find((ply) => !ply.owner)!;
    const retry = (ply: number, uci: string) => call<RetryResult & { error?: string }>(`/games/${id}/retry`, { method: "POST", body: JSON.stringify({ ply, uci }) });
    const searches = log.length;

    // The fake engine's lines are +20, +10, 0 cp: the best is correct, the second within 1 win%.
    const best = await retry(mine.ply, mine.lines[0].uci);
    expect(best.body).toMatchObject({ verdict: "correct", loss: 0, searched: false, san: mine.lines[0].san });
    expect(log).toHaveLength(searches);

    // A legal move nobody played there: one depth-matched searchmoves follow-up (-40 cp), stored.
    const known = new Set([...mine.lines.map((entry) => entry.uci), mine.uci]);
    const fresh = new Chess(mine.fenBefore).moves({ verbose: true }).map((move) => move.lan).find((uci) => !known.has(uci))!;
    const unknown = await retry(mine.ply, fresh);
    expect(unknown.body).toMatchObject({ verdict: "try-again", searched: true, uci: fresh });
    expect(unknown.body.best.san).toBe(mine.lines[0].san);
    expect(log.slice(searches)).toEqual([expect.objectContaining({ searchmoves: [fresh] })]);
    expect((await retry(mine.ply, fresh)).body.searched).toBe(false);

    expect((await retry(theirs.ply, theirs.uci)).status).toBe(400);
    expect((await retry(mine.ply, "a1a8")).status).toBe(400);
  });

  it("adds engine fields to the tree once positions are analysed, and pending before", async () => {
    const { call, backfill } = await startApi();
    const before = (await call<TreeResponse>("/tree?color=black&hl=off")).body;
    expect(before.engine).toMatchObject({ configId: 1, games: before.games, complete: 0 });
    expect(before.node.engine).toMatchObject({ eval: "pending", bestSan: null });
    expect(before.node.edges.every((edge) => edge.engine?.status === "pending")).toBe(true);

    await call("/analysis/backfill", { method: "POST", body: "{}" });
    await backfill.idle();
    const after = (await call<TreeResponse>("/tree?color=black&hl=off")).body;
    expect(after.engine).toMatchObject({ games: after.games, complete: after.games });
    expect(after.node.engine?.eval).toMatchObject({ cp: expect.any(Number) });
    const [edge] = after.node.edges;
    expect(edge.engine).toMatchObject({ status: "scored", approx: true });
    const deeper = (await call<TreeResponse>(`/tree?color=black&hl=off&moves=${edge.uci}`)).body;
    expect(deeper.node.ownerToMove).toBe(true);
    for (const row of deeper.node.edges) {
      expect(row.engine).toMatchObject({ status: "scored", approx: false, loss: expect.any(Number), cls: expect.any(String) });
      if (row.engine?.status === "scored") {
        expect(Math.abs(row.engine.eval.cp)).toBeLessThanOrEqual(1000);
      }
    }
    expect(deeper.node.engine?.hotspot.known).toBe(deeper.node.engine?.games);

    const fix = (await call<FixListResponse>("/fixlist?hl=off")).body;
    expect(fix.engine?.black).toMatchObject({ complete: fix.games.black, games: fix.games.black });
  });

  it("runs an unanalysed game's review on the pool and then records the game as analysed", async () => {
    const { call, db, jobs } = await startApi();
    const [{ id }] = db.prepare("SELECT id FROM games ORDER BY end_time DESC LIMIT 1").all() as { id: string }[];
    const [started, again] = await Promise.all([
      call<GameAnalysisResponse>(`/games/${id}/analysis`),
      call<GameAnalysisResponse>(`/games/${id}/analysis`)
    ]);
    expect(started.status).toBe(202);
    expect(started.body.review.status).toBe("partial");
    const job = started.body.job!;
    expect(job).toMatchObject({ key: `review:${id}`, type: "game-review" });
    // Opening it twice starts one job.
    expect(again.body.job?.id).toBe(job.id);
    for (let tries = 0; tries < 100 && jobs.get(job.id)?.status !== "completed"; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(jobs.get<OpeningReview>(job.id)?.result).toMatchObject({ gameId: id, status: "complete" });
    const status = await call<AnalysisStatus>("/analysis/status");
    expect(status.body.games.analysed).toBe(1);
    const reopened = await call<GameAnalysisResponse>(`/games/${id}/analysis`);
    expect(reopened.status).toBe(200);
    expect(reopened.body.job).toBeNull();
  });
});

describe("alternatives API", () => {
  it("runs the deep search once as an interactive job, then answers from the cache; never a new engine config", async () => {
    const { call, db, jobs, log } = await startApi();
    const first = await call<AlternativesResponse>("/alternatives?color=white");
    expect(first.status).toBe(202);
    expect(first.body.status).toBe("preliminary");
    expect(first.body.result.honesty.length).toBeGreaterThan(0);
    const job = first.body.job!;
    expect(job).toMatchObject({ key: "alternatives:white:" + START_EPD + ":", type: "alternatives" });
    for (let tries = 0; tries < 100 && jobs.get(job.id)?.status !== "completed"; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const done = jobs.get<AlternativesResponse>(job.id)!;
    expect(done.status).toBe("completed");
    const result = done.result!;
    expect(result).toMatchObject({ status: "complete", cost: { searched: 1 } });
    expect(result.cost!.nodes.deep).toBeGreaterThan(0);
    expect(result.result.engine).toMatchObject({ tier: "deep", multipv: 4 });
    // The deep row is stored under the one config; the protocol tiers are untouched.
    const configs = db.prepare("SELECT id FROM engine_configs").all() as { id: number }[];
    expect(configs).toHaveLength(1);
    expect(getDeepEval(db, configs[0].id, START_EPD)?.lines).toHaveLength(4);
    expect(log.some((search) => search.multipv === 4 && search.searchmoves === null)).toBe(true);
    const gated = [...result.result.alternatives, ...result.result.others];
    expect(gated.length).toBeGreaterThan(0);
    for (const alternative of gated) {
      expect(alternative.eval.gap).toBeLessThanOrEqual(result.result.gate);
    }
    const searches = log.length;
    const again = await call<AlternativesResponse>("/alternatives?color=white");
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: "complete", job: null });
    expect(log.length).toBe(searches);
    expect(JSON.stringify(again.body.result)).toBe(JSON.stringify(result.result));
  });

  it("answers Home's coverage line per colour", async () => {
    const { call } = await startApi();
    const empty = await call<RepertoireCoverageResponse>("/repertoire/coverage");
    expect(empty.status).toBe(200);
    expect(empty.body.white).toMatchObject({ entries: 0, needsReview: 0 });
    await call("/repertoire/seed", { method: "POST", body: JSON.stringify({ apply: true }) });
    const seeded = await call<RepertoireCoverageResponse>("/repertoire/coverage");
    expect(seeded.body.white.entries + seeded.body.black.entries).toBeGreaterThan(0);
    expect(seeded.body.white.coverage.map((stat) => stat.ply)).toEqual([8, 12]);
  });

  it("refuses an opponent-to-move position and an illegal move", async () => {
    const { call } = await startApi();
    const tree = await call<TreeResponse>("/tree?color=black");
    expect((await call<{ error: string }>("/alternatives?color=black")).status).toBe(400);
    const reply = tree.body.node.edges[0];
    expect((await call<AlternativesResponse>(`/alternatives?color=black&moves=${reply.uci}&uci=e1e8`)).status).toBe(400);
  });

  it("sets an alternative as the repertoire move with the replaced move and its reason", async () => {
    const { call } = await startApi();
    const put = await call<{ entry: RepEntry }>("/repertoire/entry", {
      method: "PUT",
      body: JSON.stringify({ color: "white", epd: START_EPD, uci: "d2d4", ply: 1, replaces: { uci: "e2e4", loss: 1.5, reason: "Set from the alternatives." } })
    });
    expect(put.status).toBe(200);
    expect(put.body.entry).toMatchObject({ san: "d4", source: "edited", locked: true, replaced: { san: "e4", loss: 1.5, reason: "Set from the alternatives." } });
    const bad = await call("/repertoire/entry", { method: "PUT", body: JSON.stringify({ color: "white", epd: START_EPD, uci: "c2c4", replaces: { uci: "e7e5" } }) });
    expect(bad.status).toBe(400);
  });
});

describe("repertoire API", () => {
  it("seeds as a dry run, applies, edits losslessly, never overwrites an edit, and exports PGN", async () => {
    const { call } = await startApi();
    const empty = await call<RepertoireResponse>("/repertoire");
    expect(empty.status).toBe(200);
    expect(empty.body.white).toMatchObject({ entries: 0, needsReview: 0 });
    expect(empty.body.white.nodes[0]).toMatchObject({ epd: START_EPD, ply: 0, ownerToMove: true, entry: null });

    // Dry run: a diff, nothing written.
    const dry = await call<SeedResponse>("/repertoire/seed", { method: "POST", body: "{}" });
    expect(dry.status).toBe(200);
    expect(dry.body.applied).toBe(false);
    const adds = [...dry.body.diff.white.changes, ...dry.body.diff.black.changes].filter((change) => change.kind === "add");
    expect(adds.length).toBeGreaterThan(0);
    expect((await call<RepertoireResponse>("/repertoire")).body.white.entries).toBe(0);

    const applied = await call<SeedResponse>("/repertoire/seed", { method: "POST", body: JSON.stringify({ apply: true }) });
    expect(applied.body.applied).toBe(true);
    const seeded = (await call<RepertoireResponse>("/repertoire")).body;
    expect(seeded.white.entries + seeded.black.entries).toBe(adds.length);
    // A second seed changes nothing.
    const again = await call<SeedResponse>("/repertoire/seed", { method: "POST", body: "{}" });
    expect([...again.body.diff.white.changes, ...again.body.diff.black.changes]).toEqual([]);

    // The owner sets 1.b3 at the start: edited, locked, active; the seeded move is kept as replaced.
    const put = await call<{ entry: RepEntry }>("/repertoire/entry", {
      method: "PUT",
      body: JSON.stringify({ color: "white", epd: START_EPD, san: "b3", ply: 1 })
    });
    expect(put.status).toBe(200);
    expect(put.body.entry).toMatchObject({ uci: "b2b3", san: "b3", source: "edited", status: "active", locked: true, ply: 1 });
    const key = new URLSearchParams({ color: "white", epd: START_EPD });
    const got = await call<{ entry: RepEntry }>(`/repertoire/entry?${key}`);
    expect(got.body.entry).toEqual(put.body.entry);
    // PUT round trip: sending the entry back changes nothing, not even updatedAt.
    const { uci, locked, status, note } = got.body.entry;
    const same = await call<{ entry: RepEntry }>("/repertoire/entry", {
      method: "PUT",
      body: JSON.stringify({ color: "white", epd: START_EPD, uci, locked, status, note })
    });
    expect(same.body.entry).toEqual(got.body.entry);

    // Re-seeding never overwrites the edit.
    const reseed = await call<SeedResponse>("/repertoire/seed", { method: "POST", body: JSON.stringify({ apply: true }) });
    expect(reseed.body.diff.white.kept).toBeGreaterThanOrEqual(1);
    expect(reseed.body.diff.white.changes.some((change) => change.epd === START_EPD)).toBe(false);
    expect((await call<{ entry: RepEntry }>(`/repertoire/entry?${key}`)).body.entry).toEqual(got.body.entry);

    // The tree's start node carries the entry; the export is PGN.
    const tree = await call<TreeResponse>("/tree?color=white");
    expect(tree.body.repertoire).toMatchObject({ san: "b3", source: "edited" });
    const exported = await call<string>("/repertoire/export?color=white");
    expect(exported.status).toBe(200);
    expect(exported.body).toContain('[Event "kubista9 repertoire as White"]');
    expect(exported.body).toMatch(/\n1\. b3 \{edited\}/);

    // Bad input: an illegal move, the wrong side to move, an unknown entry.
    const illegal = await call("/repertoire/entry", { method: "PUT", body: JSON.stringify({ color: "white", epd: START_EPD, san: "Ke2" }) });
    expect(illegal.status).toBe(400);
    const wrongSide = await call("/repertoire/entry", { method: "PUT", body: JSON.stringify({ color: "black", epd: START_EPD, san: "e5", ply: 1 }) });
    expect(wrongSide.status).toBe(400);
    const deleted = await call(`/repertoire/entry?${key}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect((await call(`/repertoire/entry?${key}`, { method: "DELETE" })).status).toBe(404);
  });

  it("marks where a reviewed game left the repertoire", async () => {
    const { call, db } = await startApi();
    const id = (db.prepare("SELECT id FROM games WHERE color = 'white' ORDER BY end_time LIMIT 1").get() as { id: string }).id;
    const first = getGamePlies(db, id)[0];
    const other = first.uci === "e2e4" ? "d4" : "e4";
    await call("/repertoire/entry", { method: "PUT", body: JSON.stringify({ color: "white", epd: START_EPD, san: other, ply: 1 }) });
    const response = await call<GameAnalysisResponse>(`/games/${id}/analysis`);
    expect(response.body.repertoire).toMatchObject({
      entries: 1,
      deviation: { ply: 1, played: { uci: first.uci }, expected: { san: other } },
      unprepared: null,
      inRepThrough: 0
    });
  });
});

describe("drills API", () => {
  async function waitFor(jobs: JobStore, id: string) {
    for (let tries = 0; tries < 200 && jobs.get(id)?.status !== "completed" && jobs.get(id)?.status !== "failed"; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(jobs.get(id)?.status).toBe("completed");
  }

  it("drills a repertoire line and a position from a game, grades the first try only, and regenerates idempotently", async () => {
    const { call, db, jobs, backfill } = await startApi();
    const empty = await call<DrillStats>("/drills/stats");
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ repertoireEntries: 0, total: { "repertoire-line": 0, "own-mistake": 0 }, engine: true });

    await call("/analysis/backfill", { method: "POST", body: JSON.stringify({ allowBattery: true }) });
    await backfill.idle();
    const put = await call("/repertoire/entry", { method: "PUT", body: JSON.stringify({ color: "white", epd: START_EPD, uci: "e2e4", ply: 1 }) });
    expect(put.status).toBe(200);

    // An adopted (edited) entry is a due line card at once.
    const lines = await call<DrillSessionResponse>("/drills/due?kind=repertoire-line");
    expect(lines.status).toBe(200);
    const run = lines.body.items[0] as LineRunItem;
    expect(run).toMatchObject({ type: "line-run", color: "white" });
    expect(run.steps[0]).toMatchObject({ ply: 1, mover: "owner", uci: "e2e4", graded: true });
    const id = `repertoire-line|white|${START_EPD}`;
    expect(run.cards[START_EPD]).toMatchObject({ id, kind: "repertoire-line", primary: { san: "e4" } });
    expect(lines.body.stats.due["repertoire-line"]).toBe(1);

    const right = await call<DrillAnswerResponse>("/drills/answer", { method: "POST", body: JSON.stringify({ id, uci: "e2e4", attempts: 1, ms: 900 }) });
    expect(right.body).toMatchObject({ verdict: "correct", correct: true, graded: true, box: 2 });
    expect(Math.abs(right.body.nextDue! - (NOW + 86_400_000))).toBeLessThanOrEqual(0.05 * 86_400_000);
    const other = await call<DrillAnswerResponse>("/drills/answer", { method: "POST", body: JSON.stringify({ id, uci: "g2g4", attempts: 2 }) });
    expect(other.body.verdict).not.toBe("correct");
    expect(other.body).toMatchObject({ graded: false, repertoire: { san: "e4" }, box: 2 });
    const illegal = await call("/drills/answer", { method: "POST", body: JSON.stringify({ id, uci: "e2e5", attempts: 1 }) });
    expect(illegal.status).toBe(400);

    // Mistake cards: today's new ones get their deep check as one job, then drill.
    const first = await call<DrillSessionResponse>("/drills/due?kind=own-mistake");
    expect(first.status).toBe(200);
    if (first.body.job) {
      expect(first.body.job).toMatchObject({ key: "drills:check", type: "drill-check" });
      await waitFor(jobs, first.body.job.id);
    }
    const mistakes = await call<DrillSessionResponse>("/drills/due?kind=own-mistake");
    const items = mistakes.body.items as MistakeItem[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(5);
    const card = items[0].card;
    expect(card).toMatchObject({ kind: "own-mistake", primary: null, box: 1 });
    expect(card.sources.length).toBeGreaterThan(0);
    const wrong = await call<DrillAnswerResponse>("/drills/answer", {
      method: "POST",
      body: JSON.stringify({ id: card.id, uci: card.sources[0].playedUci, attempts: 1 })
    });
    expect(wrong.body).toMatchObject({ verdict: "wrong", graded: true, box: 1, nextDue: NOW + 86_400_000 });
    expect(wrong.body.acceptable.map((move) => move.uci)).toContain(wrong.body.best!.uci);
    const best = await call<DrillAnswerResponse>("/drills/answer", {
      method: "POST",
      body: JSON.stringify({ id: card.id, uci: wrong.body.best!.uci, attempts: 2 })
    });
    expect(best.body).toMatchObject({ verdict: "best", correct: true, graded: false });

    const stats = await call<DrillStats>("/drills/stats");
    expect(stats.body.reviewedToday["repertoire-line"]).toEqual({ correct: 1, wrong: 0 });
    expect(stats.body.reviewedToday["own-mistake"]).toEqual({ correct: 0, wrong: 1 });
    const logged = db.prepare("SELECT COUNT(*) AS n FROM drill_reviews").get() as { n: number };
    expect(logged.n).toBe(4);

    // One card per (colour, EPD), and a forced regeneration writes nothing new.
    const dupes = db.prepare("SELECT color, epd, COUNT(*) AS n FROM drill_cards WHERE status = 'active' GROUP BY color, epd HAVING n > 1").all();
    expect(dupes).toEqual([]);
    const regen = await call<{ written: number }>("/drills/regenerate", { method: "POST", body: "{}" });
    expect(regen.body.written).toBe(0);
    const focus = await call<DrillSessionResponse>(`/drills/due?color=white&moves=h2h3,h7h6`);
    expect(focus.status).toBe(200);
    expect(focus.body.focusNote).toMatch(/no drill for this position/);

    // Seeded (not edited) entries: their new line cards wait for the daily cap of 5.
    for (const [moves, uci] of [
      [["e2e4", "e7e5"], "g1f3"],
      [["e2e4", "c7c5"], "g1f3"],
      [["e2e4", "e7e6"], "d2d4"],
      [["e2e4", "c7c6"], "d2d4"],
      [["e2e4", "d7d5"], "e4d5"],
      [["e2e4", "g8f6"], "e4e5"],
      [["e2e4", "d7d6"], "d2d4"]
    ] as const) {
      upsertRepEntry(db, OWNER, { ...entry("white", moves, uci, NOW), source: "from-games" });
    }
    const seeded = await call<DrillStats>("/drills/stats");
    expect(seeded.body.repertoireEntries).toBe(8);
    expect(seeded.body.total["repertoire-line"]).toBeGreaterThan(seeded.body.due["repertoire-line"]);
    expect(seeded.body.due["repertoire-line"]).toBeLessThanOrEqual(5);
  });
});

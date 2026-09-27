import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { GamesResponse, JobState, OpeningReportResponse, SyncSummary } from "../shared/types.js";
import { loadOwnerGames } from "../test/loadFixtures.js";
import { createApp } from "./app.js";
import { openDatabase, type Db } from "./db/connection.js";
import { replaceMonthGames } from "./db/games.js";
import { createApiRouter } from "./routes.js";
import { deriveMonth, utcMonth } from "./services/gameDerive.js";
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
  const router = createApiRouter({ db: () => db, jobs, owner: OWNER, now: () => NOW, sync });
  const server = createApp(router).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async <T>(path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json" }
    });
    return { status: response.status, body: (await response.json()) as T };
  };
  return { call, jobs };
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

describe("games and report API", () => {
  it("lists every stored game in the window, newest first, and filters", async () => {
    const { call } = await startApi();
    const all = await call<GamesResponse>("/games");
    expect(all.body.window).toMatchObject({ key: "6m", days: 183 });
    expect(all.body.games).toHaveLength(8);
    expect(all.body.games[0].id).toBe("184405952510");

    const recent = await call<GamesResponse>("/games?window=3m");
    expect(recent.body.games.map((game) => game.endTime >= recent.body.window.start)).not.toContain(false);
    expect(recent.body.games).toHaveLength(5);

    const black = await call<GamesResponse>("/games?color=black");
    expect(black.body.games.every((game) => game.color === "black")).toBe(true);

    expect((await call("/games?window=12m")).status).toBe(400);
    expect((await call("/games?tc=bullet")).status).toBe(400);
  });

  it("opens a stored game by id and 404s an unknown one", async () => {
    const { call } = await startApi();
    const found = await call<{ game: { id: string; color: string } }>("/games/184405952510");
    expect(found.body.game).toMatchObject({ id: "184405952510", color: "black" });
    expect((await call("/games/1")).status).toBe(404);
  });

  it("reports per colour, and each colour's items add up to its games", async () => {
    const { call } = await startApi();
    const { body } = await call<OpeningReportResponse>("/openings/report");
    expect(body.totals.white + body.totals.black).toBe(8);
    for (const color of ["white", "black"] as const) {
      const sum = body.items.filter((item) => item.color === color).reduce((total, item) => total + item.games, 0);
      expect(sum).toBe(body.totals[color]);
    }
  });
});

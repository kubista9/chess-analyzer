import "fake-indexeddb/auto";
import { openDB } from "idb";
import { describe, expect, it } from "vitest";
import type { AttemptRecord } from "../core/training/types";
import { ALL_STORES, DB_NAME, DB_VERSION, openTrainerDb, upgradeTrainerDb, type TrainerDbSchema } from "./db";

const NOW = Date.UTC(2026, 9, 1, 12);
const LATER = Date.UTC(2026, 9, 20, 12);

let databases = 0;
/** A database name no other test uses. */
function freshName(): string {
  databases += 1;
  return `db-test-${databases}`;
}

function attempt(overrides: Partial<AttemptRecord>): AttemptRecord {
  return {
    at: NOW,
    day: "2026-10-01",
    mode: "next-move",
    side: "white",
    lineId: "eng-a",
    posKey: "white|epd-a",
    epd: "epd-a",
    expected: ["c4"],
    tries: [{ san: "c4", verdict: "book" }],
    hintsShown: 0,
    revealed: false,
    result: "clean",
    durationMs: 1000,
    ...overrides
  };
}

describe("openTrainerDb", () => {
  it("uses the app's name and version", () => {
    expect(DB_NAME).toBe("opening-trainer");
    expect(DB_VERSION).toBe(1);
  });

  it("creates every store with its key and indexes", async () => {
    const db = await openTrainerDb(freshName(), { now: () => NOW });
    expect([...db.objectStoreNames].sort()).toEqual([...ALL_STORES].sort());
    const tx = db.transaction(ALL_STORES, "readonly");
    const shape = Object.fromEntries(
      ALL_STORES.map((name) => {
        const store = tx.objectStore(name);
        const indexes = Object.fromEntries([...store.indexNames].map((index) => [index, store.index(index).keyPath]));
        return [name, { keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes }];
      })
    );
    expect(shape).toEqual({
      settings: { keyPath: null, autoIncrement: false, indexes: {} },
      lineStates: { keyPath: "lineId", autoIncrement: false, indexes: {} },
      positionProgress: { keyPath: "key", autoIncrement: false, indexes: { "by-side": "side" } },
      lineProgress: { keyPath: "lineId", autoIncrement: false, indexes: {} },
      attempts: {
        keyPath: "id",
        autoIncrement: true,
        indexes: { "by-at": "at", "by-day": "day", "by-pos": "posKey", "by-line": "lineId" }
      },
      customLines: { keyPath: "id", autoIncrement: false, indexes: {} },
      meta: { keyPath: null, autoIncrement: false, indexes: {} }
    });
    await tx.done;
    db.close();
  });

  it("stamps the schema version and the creation time", async () => {
    const db = await openTrainerDb(freshName(), { now: () => NOW });
    expect(await db.get("meta", "schemaVersion")).toBe(DB_VERSION);
    expect(await db.get("meta", "createdAt")).toBe(NOW);
    db.close();
  });

  it("does not run the creation step again when reopened", async () => {
    const name = freshName();
    const first = await openTrainerDb(name, { now: () => NOW });
    await first.put("lineStates", { lineId: "eng-a", enabled: false, status: "learning", statusSetAt: null, updatedAt: NOW });
    first.close();
    const second = await openTrainerDb(name, { now: () => LATER });
    expect(await second.get("meta", "createdAt")).toBe(NOW);
    expect(await second.get("lineStates", "eng-a")).toMatchObject({ enabled: false });
    second.close();
  });

  it("indexes progress by side and leaves attempts without a position or line out of those indexes", async () => {
    const db = await openTrainerDb(freshName(), { now: () => NOW });
    const srs = { box: 0, dueAt: null, introducedAt: null, lapses: 0, streak: 0, reviews: 0, lastReviewAt: null };
    const progress = (side: "white" | "black", epd: string) => ({
      key: `${side}|${epd}`,
      side,
      epd,
      attempts: 0,
      clean: 0,
      incorrect: 0,
      wrongTries: 0,
      hintsUsed: 0,
      reveals: 0,
      firstSeenAt: null,
      lastPracticedAt: null,
      lastResult: null,
      recent: [],
      mastery: 0,
      srs,
      weakMoves: []
    });
    await db.put("positionProgress", progress("white", "a"));
    await db.put("positionProgress", progress("black", "b"));
    await db.put("positionProgress", progress("white", "c"));
    expect((await db.getAllFromIndex("positionProgress", "by-side", "white")).map((p) => p.key)).toEqual(["white|a", "white|c"]);

    await db.add("attempts", attempt({}));
    await db.add("attempts", attempt({ mode: "recall", posKey: null, epd: null }));
    await db.add("attempts", attempt({ mode: "sparring", lineId: null }));
    expect(await db.count("attempts")).toBe(3);
    expect(await db.countFromIndex("attempts", "by-pos")).toBe(2);
    expect(await db.countFromIndex("attempts", "by-line")).toBe(2);
    expect(await db.countFromIndex("attempts", "by-at")).toBe(3);
    db.close();
  });

  it("closes itself when another tab opens a newer version, so that tab is not blocked", async () => {
    const name = freshName();
    const db = await openTrainerDb(name, { now: () => NOW });
    let blocked = false;
    const newer = await openDB(name, DB_VERSION + 1, {
      blocked: () => {
        blocked = true;
      }
    });
    expect(blocked).toBe(false);
    expect(newer.version).toBe(DB_VERSION + 1);
    newer.close();
    db.close();
  });
});

describe("upgradeTrainerDb", () => {
  it("migrates an existing database forward without recreating its stores or losing data", async () => {
    const name = freshName();
    const v1 = await openTrainerDb(name, { now: () => NOW });
    await v1.add("attempts", attempt({}));
    v1.close();

    // A future build opening this database at the next version runs the same switch from oldVersion 1.
    const seen: number[] = [];
    const next = await openDB<TrainerDbSchema>(name, DB_VERSION + 1, {
      upgrade(database, oldVersion, newVersion, transaction) {
        seen.push(oldVersion);
        upgradeTrainerDb(database, transaction, oldVersion, newVersion ?? DB_VERSION + 1, LATER);
      }
    });
    expect(seen).toEqual([DB_VERSION]);
    expect(await next.get("meta", "schemaVersion")).toBe(DB_VERSION + 1);
    expect(await next.get("meta", "createdAt")).toBe(NOW);
    expect(await next.count("attempts")).toBe(1);
    next.close();
  });

  it("runs every step from an empty database, whatever the target version", async () => {
    const db = await openDB<TrainerDbSchema>(freshName(), DB_VERSION + 1, {
      upgrade(database, oldVersion, newVersion, transaction) {
        upgradeTrainerDb(database, transaction, oldVersion, newVersion ?? DB_VERSION + 1, NOW);
      }
    });
    expect([...db.objectStoreNames].sort()).toEqual([...ALL_STORES].sort());
    expect(await db.get("meta", "schemaVersion")).toBe(DB_VERSION + 1);
    expect(await db.get("meta", "createdAt")).toBe(NOW);
    db.close();
  });
});

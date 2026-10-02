import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { posKey } from "../core/content/types";
import {
  DEFAULT_SETTINGS,
  type AttemptRecord,
  type CustomLineRecord,
  type LineProgress,
  type LineState,
  type PositionProgress,
  type Settings,
  type SrsState
} from "../core/training/types";
import { DAY_MS, MINUTE_MS, dayKey } from "../core/util/time";
import { BACKUP_APP, BACKUP_FORMAT, BackupError, type BackupFile } from "./backup";
import { openTrainerDb } from "./db";
import { RECENT_ATTEMPTS_DAYS, openTrainerStore, type TrainerStore } from "./store";

const NOW = Date.UTC(2026, 9, 1, 12);
const clock = () => NOW;

let databases = 0;
/** A database name no other test uses. */
function freshName(): string {
  databases += 1;
  return `store-test-${databases}`;
}

const open: TrainerStore[] = [];
async function freshStore(name = freshName()): Promise<TrainerStore> {
  const store = await openTrainerStore(name, { now: clock });
  open.push(store);
  return store;
}

afterEach(() => {
  for (const store of open.splice(0)) {
    store.close();
  }
  vi.unstubAllGlobals();
});

function srs(overrides: Partial<SrsState> = {}): SrsState {
  return { box: 1, dueAt: NOW + DAY_MS, introducedAt: NOW, lapses: 0, streak: 1, reviews: 1, lastReviewAt: NOW, ...overrides };
}

function position(epd: string, overrides: Partial<PositionProgress> = {}): PositionProgress {
  const side = overrides.side ?? "white";
  return {
    key: posKey(side, epd),
    side,
    epd,
    attempts: 1,
    clean: 1,
    incorrect: 0,
    wrongTries: 0,
    hintsUsed: 0,
    reveals: 0,
    firstSeenAt: NOW,
    lastPracticedAt: NOW,
    lastResult: "clean",
    recent: ["clean"],
    mastery: 0.5,
    srs: srs(),
    weakMoves: [{ san: "e4", count: 1, lastAt: NOW }],
    ...overrides
  };
}

function lineProgress(lineId: string, overrides: Partial<LineProgress> = {}): LineProgress {
  return {
    lineId,
    runs: 1,
    cleanRuns: 1,
    movesPlayed: 6,
    movesClean: 6,
    wrongTries: 0,
    hintsUsed: 0,
    reveals: 0,
    recallAttempts: 0,
    recallCorrect: 0,
    lastPracticedAt: NOW,
    lastResult: "clean",
    srs: srs(),
    ...overrides
  };
}

function lineState(lineId: string, overrides: Partial<LineState> = {}): LineState {
  return { lineId, enabled: true, status: "learning", statusSetAt: null, updatedAt: NOW, ...overrides };
}

function customLine(id: string, overrides: Partial<CustomLineRecord> = {}): CustomLineRecord {
  return {
    id,
    side: "black",
    chapter: "My lines",
    family: "English Opening",
    name: "Reversed Sicilian",
    eco: "A20",
    moves: "1.c4 e5 2.Nc3 Nf6",
    description: "A line of my own.",
    plans: ["Play ...d5 when it is safe."],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  const at = overrides.at ?? NOW;
  return {
    at,
    day: dayKey(at),
    mode: "next-move",
    side: "white",
    lineId: "eng-a",
    posKey: posKey("white", "epd-a"),
    epd: "epd-a",
    expected: ["c4"],
    tries: [{ san: "c4", verdict: "book" }],
    hintsShown: 0,
    revealed: false,
    result: "clean",
    durationMs: 1200,
    ...overrides
  };
}

const CUSTOM_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  board: { ...DEFAULT_SETTINGS.board, theme: "blue", animationMs: 0 },
  practice: { ...DEFAULT_SETTINGS.practice, newPerDay: 4, revealAfter: 5 }
};

/** A store with something in every store. Returns the attempt ids. */
async function populate(store: TrainerStore): Promise<number[]> {
  await store.saveSettings(CUSTOM_SETTINGS);
  await store.putLineStates([lineState("eng-a"), lineState("eng-b", { enabled: false, status: "mastered", statusSetAt: NOW })]);
  await store.putCustomLine(customLine("custom-1"));
  const ids: number[] = [];
  ids.push(
    (await store.record({
      attempt: attempt({ at: NOW - 2 * DAY_MS }),
      positions: [position("epd-a", { lastPracticedAt: NOW - 2 * DAY_MS })],
      lines: [lineProgress("eng-a", { lastPracticedAt: NOW - 2 * DAY_MS })]
    }))!
  );
  ids.push(
    (await store.record({
      attempt: attempt({ at: NOW - DAY_MS, side: "black", posKey: posKey("black", "epd-b"), epd: "epd-b", lineId: "fr-a", result: "revealed" }),
      positions: [position("epd-b", { side: "black", lastResult: "revealed" })],
      lines: [lineProgress("fr-a")]
    }))!
  );
  ids.push((await store.record({ attempt: attempt({ at: NOW, mode: "recall", posKey: null, epd: null, expected: ["Four Knights"], tries: [] }) }))!);
  return ids;
}

async function rawCounts(name: string): Promise<Record<string, number>> {
  const db = await openTrainerDb(name, { now: clock });
  const names = ["settings", "lineStates", "positionProgress", "lineProgress", "attempts", "customLines", "meta"] as const;
  const counts = Object.fromEntries(await Promise.all(names.map(async (store) => [store, await db.count(store)] as const)));
  db.close();
  return counts;
}

describe("load", () => {
  it("returns the defaults and empty lists for a new database", async () => {
    const store = await freshStore();
    expect(await store.load()).toEqual({
      settings: DEFAULT_SETTINGS,
      lineStates: [],
      positionProgress: [],
      lineProgress: [],
      customLines: [],
      recentAttempts: [],
      practiceDays: []
    });
  });

  it("reads attempts of the last RECENT_ATTEMPTS_DAYS by default, newest first, but practice days of all time", async () => {
    const store = await freshStore();
    const old = NOW - (RECENT_ATTEMPTS_DAYS + 1) * DAY_MS;
    const edge = NOW - RECENT_ATTEMPTS_DAYS * DAY_MS;
    const recent = NOW - 3 * DAY_MS;
    for (const at of [recent, old, edge]) {
      await store.record({ attempt: attempt({ at }) });
    }
    const snapshot = await store.load();
    expect(snapshot.recentAttempts.map((a) => a.at)).toEqual([recent, edge]);
    expect(snapshot.practiceDays).toEqual([dayKey(old), dayKey(edge), dayKey(recent)]);
    expect((await store.load({ attemptsSinceMs: 0 })).recentAttempts.map((a) => a.at)).toEqual([recent, edge, old]);
    expect((await store.load({ attemptsSinceMs: recent + 1 })).recentAttempts).toEqual([]);
  });

  it("uses the store's clock for the default window", async () => {
    const name = freshName();
    const later = await openTrainerStore(name, { now: () => NOW + 200 * DAY_MS });
    open.push(later);
    await later.record({ attempt: attempt({ at: NOW }) });
    expect((await later.load()).recentAttempts).toEqual([]);
    expect((await (await freshStore(name)).load()).recentAttempts).toHaveLength(1);
  });
});

describe("settings", () => {
  it("round-trips saved settings", async () => {
    const store = await freshStore();
    await store.saveSettings(CUSTOM_SETTINGS);
    expect((await store.load()).settings).toEqual(CUSTOM_SETTINGS);
    await store.saveSettings(DEFAULT_SETTINGS);
    expect((await store.load()).settings).toEqual(DEFAULT_SETTINGS);
  });

  it("normalises settings before saving them", async () => {
    const name = freshName();
    const store = await freshStore(name);
    const messy = {
      ...CUSTOM_SETTINGS,
      sound: { enabled: true, volume: 3 },
      practice: { newPerDay: 500, revealAfter: 1, replyDelayMs: -10 },
      extra: "dropped"
    } as unknown as Settings;
    await store.saveSettings(messy);
    const db = await openTrainerDb(name);
    expect(await db.get("settings", "settings")).toEqual({
      ...CUSTOM_SETTINGS,
      sound: { enabled: true, volume: 1 },
      practice: { newPerDay: 50, revealAfter: 3, replyDelayMs: 0 }
    });
    db.close();
  });

  it("merges settings written by an older or newer build over the defaults on load", async () => {
    const name = freshName();
    const db = await openTrainerDb(name);
    await db.put("settings", { board: { theme: "brown", pieceSet: "alpha" }, sound: { volume: 0.1 }, beta: true }, "settings");
    db.close();
    const store = await freshStore(name);
    expect((await store.load()).settings).toEqual({
      ...DEFAULT_SETTINGS,
      board: { ...DEFAULT_SETTINGS.board, theme: "brown" },
      sound: { ...DEFAULT_SETTINGS.sound, volume: 0.1 }
    });
  });
});

describe("line states and custom lines", () => {
  it("round-trips line states and overwrites them by line id", async () => {
    const store = await freshStore();
    await store.putLineStates([lineState("b-line"), lineState("a-line", { enabled: false })]);
    await store.putLineStates([lineState("b-line", { status: "mastered", statusSetAt: NOW, updatedAt: NOW + 1 })]);
    await store.putLineStates([]);
    expect((await store.load()).lineStates).toEqual([
      lineState("a-line", { enabled: false }),
      lineState("b-line", { status: "mastered", statusSetAt: NOW, updatedAt: NOW + 1 })
    ]);
  });

  it("puts, overwrites and deletes custom lines", async () => {
    const store = await freshStore();
    await store.putCustomLine(customLine("custom-2"));
    await store.putCustomLine(customLine("custom-1"));
    await store.putCustomLine(customLine("custom-2", { name: "Renamed", updatedAt: NOW + 5 }));
    expect((await store.load()).customLines).toEqual([customLine("custom-1"), customLine("custom-2", { name: "Renamed", updatedAt: NOW + 5 })]);
    await store.deleteCustomLine("custom-1");
    await store.deleteCustomLine("never-existed");
    expect((await store.load()).customLines.map((line) => line.id)).toEqual(["custom-2"]);
  });
});

describe("record", () => {
  it("writes progress and the attempt together and returns increasing ids", async () => {
    const store = await freshStore();
    const first = await store.record({ attempt: attempt(), positions: [position("epd-a")], lines: [lineProgress("eng-a")] });
    const second = await store.record({ attempt: attempt({ at: NOW + MINUTE_MS }), positions: [position("epd-a", { attempts: 2 })] });
    expect(first).toBeTypeOf("number");
    expect(second).toBeGreaterThan(first!);
    const snapshot = await store.load();
    expect(snapshot.positionProgress).toEqual([position("epd-a", { attempts: 2 })]);
    expect(snapshot.lineProgress).toEqual([lineProgress("eng-a")]);
    expect(snapshot.recentAttempts).toEqual([
      { ...attempt({ at: NOW + MINUTE_MS }), id: second },
      { ...attempt(), id: first }
    ]);
  });

  it("assigns its own id, ignoring one passed in", async () => {
    const store = await freshStore();
    const first = await store.record({ attempt: attempt() });
    const second = await store.record({ attempt: { ...attempt({ at: NOW + 1 }), id: first! } });
    expect(second).not.toBe(first);
    expect(await store.listAttempts()).toHaveLength(2);
  });

  it("returns null and writes nothing else when there is no attempt", async () => {
    const store = await freshStore();
    expect(await store.record({ positions: [position("epd-a")] })).toBeNull();
    expect(await store.record({})).toBeNull();
    expect(await store.record({ positions: [], lines: [] })).toBeNull();
    const snapshot = await store.load();
    expect(snapshot.positionProgress).toHaveLength(1);
    expect(snapshot.recentAttempts).toEqual([]);
  });

  it("writes several positions and lines in one call", async () => {
    const store = await freshStore();
    await store.record({
      positions: [position("epd-b"), position("epd-a"), position("epd-a", { side: "black" })],
      lines: [lineProgress("x"), lineProgress("y")]
    });
    const snapshot = await store.load();
    expect(snapshot.positionProgress.map((p) => p.key)).toEqual(["black|epd-a", "white|epd-a", "white|epd-b"]);
    expect(snapshot.lineProgress.map((p) => p.lineId)).toEqual(["x", "y"]);
  });

  it("writes nothing when the attempt cannot be stored (one transaction)", async () => {
    const name = freshName();
    const store = await freshStore(name);
    await store.record({
      attempt: attempt({ at: NOW - DAY_MS }),
      positions: [position("epd-a", { attempts: 1 })],
      lines: [lineProgress("eng-a", { runs: 1 })]
    });
    const before = await store.load();

    const broken = { ...attempt(), onDone: () => undefined } as unknown as AttemptRecord;
    await expect(
      store.record({
        positions: [position("epd-a", { attempts: 2 }), position("epd-new")],
        lines: [lineProgress("eng-a", { runs: 2 }), lineProgress("eng-new")],
        attempt: broken
      })
    ).rejects.toMatchObject({ name: "DataCloneError" });

    expect(await store.load()).toEqual(before);
    expect(await rawCounts(name)).toMatchObject({ positionProgress: 1, lineProgress: 1, attempts: 1 });
  });

  it("writes nothing when a progress record has no key", async () => {
    const store = await freshStore();
    const before = await store.load();
    const keyless = { ...position("epd-z"), key: undefined } as unknown as PositionProgress;
    const input = { lines: [lineProgress("eng-a")], positions: [position("epd-a"), keyless], attempt: attempt() };
    await expect(store.record(input)).rejects.toMatchObject({ name: "DataError" });
    expect(await store.load()).toEqual(before);
  });

  it("keeps working after a failed write", async () => {
    const store = await freshStore();
    const broken = { ...attempt(), extra: Symbol("x") } as unknown as AttemptRecord;
    await expect(store.record({ attempt: broken, positions: [position("epd-a")] })).rejects.toThrow();
    const id = await store.record({ attempt: attempt(), positions: [position("epd-a")] });
    expect(id).toBeTypeOf("number");
    expect((await store.load()).positionProgress).toHaveLength(1);
  });
});

describe("listAttempts", () => {
  const T0 = NOW - 3 * DAY_MS;
  const T1 = NOW - 2 * DAY_MS;
  const T2 = NOW - DAY_MS;
  const T3 = NOW;
  const POS_A = posKey("white", "epd-a");
  const POS_B = posKey("white", "epd-b");
  const POS_C = posKey("black", "epd-c");

  async function seeded(): Promise<{ store: TrainerStore; ids: Record<string, number> }> {
    const store = await freshStore();
    const inputs: [string, AttemptRecord][] = [
      ["a1", attempt({ at: T0, posKey: POS_A, lineId: "line-a" })],
      ["a2", attempt({ at: T1, posKey: POS_B, lineId: "line-a" })],
      ["a3", attempt({ at: T1, posKey: POS_A, lineId: "line-b" })],
      ["a4", attempt({ at: T2, mode: "recall", posKey: null, epd: null, lineId: "line-a" })],
      ["a5", attempt({ at: T3, mode: "sparring", side: "black", posKey: POS_C, lineId: null })]
    ];
    const ids: Record<string, number> = {};
    for (const [label, record] of inputs) {
      ids[label] = (await store.record({ attempt: record }))!;
    }
    return { store, ids };
  }

  async function labels(store: TrainerStore, ids: Record<string, number>, options?: Parameters<TrainerStore["listAttempts"]>[0]): Promise<string[]> {
    const byId = new Map(Object.entries(ids).map(([label, id]) => [id, label]));
    return (await store.listAttempts(options)).map((record) => byId.get(record.id!)!);
  }

  it("lists every attempt newest first, ties broken by the higher id", async () => {
    const { store, ids } = await seeded();
    expect(await labels(store, ids)).toEqual(["a5", "a4", "a3", "a2", "a1"]);
    expect(await labels(store, ids, {})).toEqual(["a5", "a4", "a3", "a2", "a1"]);
  });

  it("filters by time (inclusive) and limits to the newest", async () => {
    const { store, ids } = await seeded();
    expect(await labels(store, ids, { sinceMs: T1 })).toEqual(["a5", "a4", "a3", "a2"]);
    expect(await labels(store, ids, { sinceMs: T1 + 1 })).toEqual(["a5", "a4"]);
    expect(await labels(store, ids, { sinceMs: T3 + 1 })).toEqual([]);
    expect(await labels(store, ids, { limit: 2 })).toEqual(["a5", "a4"]);
    expect(await labels(store, ids, { sinceMs: T1, limit: 3 })).toEqual(["a5", "a4", "a3"]);
    expect(await labels(store, ids, { limit: 10 })).toEqual(["a5", "a4", "a3", "a2", "a1"]);
    expect(await labels(store, ids, { limit: 2.9 })).toEqual(["a5", "a4"]);
    expect(await labels(store, ids, { limit: 0 })).toEqual([]);
    expect(await labels(store, ids, { limit: -1 })).toEqual([]);
  });

  it("filters by position, by line and by both", async () => {
    const { store, ids } = await seeded();
    expect(await labels(store, ids, { posKey: POS_A })).toEqual(["a3", "a1"]);
    expect(await labels(store, ids, { lineId: "line-a" })).toEqual(["a4", "a2", "a1"]);
    expect(await labels(store, ids, { posKey: POS_A, lineId: "line-a" })).toEqual(["a1"]);
    expect(await labels(store, ids, { posKey: POS_A, lineId: "line-c" })).toEqual([]);
    expect(await labels(store, ids, { posKey: "white|nowhere" })).toEqual([]);
    expect(await labels(store, ids, { lineId: "nowhere" })).toEqual([]);
  });

  it("combines position or line filters with time and limit", async () => {
    const { store, ids } = await seeded();
    expect(await labels(store, ids, { posKey: POS_A, sinceMs: T1 })).toEqual(["a3"]);
    expect(await labels(store, ids, { lineId: "line-a", sinceMs: T1, limit: 1 })).toEqual(["a4"]);
    expect(await labels(store, ids, { lineId: "line-a", limit: 2 })).toEqual(["a4", "a2"]);
    expect(await labels(store, ids, { posKey: POS_C, lineId: undefined })).toEqual(["a5"]);
  });

  it("returns complete records", async () => {
    const { store, ids } = await seeded();
    const [newest] = await store.listAttempts({ limit: 1 });
    expect(newest).toEqual({ ...attempt({ at: T3, mode: "sparring", side: "black", posKey: POS_C, lineId: null }), id: ids.a5 });
  });
});

describe("practiceDays", () => {
  it("returns each day with an attempt once, in ascending order", async () => {
    const store = await freshStore();
    expect(await store.practiceDays()).toEqual([]);
    for (const at of [NOW, NOW - 5 * DAY_MS, NOW + MINUTE_MS, NOW - DAY_MS, NOW - 5 * DAY_MS + MINUTE_MS]) {
      await store.record({ attempt: attempt({ at }) });
    }
    expect(await store.practiceDays()).toEqual([dayKey(NOW - 5 * DAY_MS), dayKey(NOW - DAY_MS), dayKey(NOW)]);
    expect((await store.load()).practiceDays).toEqual(await store.practiceDays());
  });

  it("uses the stored day key, not the time", async () => {
    const store = await freshStore();
    // Recorded on another device in another time zone: its local day is what counts.
    await store.record({ attempt: { ...attempt({ at: NOW }), day: "2026-09-30" } });
    await store.record({ attempt: { ...attempt({ at: NOW }), day: "2026-10-01" } });
    expect(await store.practiceDays()).toEqual(["2026-09-30", "2026-10-01"]);
  });
});

describe("exportBackup", () => {
  it("exports every store with the app's header", async () => {
    const store = await freshStore();
    const ids = await populate(store);
    const backup = await store.exportBackup(NOW + 7);
    expect(backup.app).toBe(BACKUP_APP);
    expect(backup.format).toBe(BACKUP_FORMAT);
    expect(backup.exportedAt).toBe(NOW + 7);
    expect(backup.settings).toEqual(CUSTOM_SETTINGS);
    expect(backup.lineStates.map((state) => state.lineId)).toEqual(["eng-a", "eng-b"]);
    expect(backup.positionProgress.map((progress) => progress.key)).toEqual(["black|epd-b", "white|epd-a"]);
    expect(backup.lineProgress.map((progress) => progress.lineId)).toEqual(["eng-a", "fr-a"]);
    expect(backup.attempts.map((record) => record.id)).toEqual(ids);
    expect(backup.customLines).toEqual([customLine("custom-1")]);
  });

  it("exports default settings when none were saved", async () => {
    const store = await freshStore();
    const backup = await store.exportBackup(NOW);
    expect(backup).toEqual({
      app: BACKUP_APP,
      format: BACKUP_FORMAT,
      exportedAt: NOW,
      settings: DEFAULT_SETTINGS,
      lineStates: [],
      positionProgress: [],
      lineProgress: [],
      attempts: [],
      customLines: []
    });
  });

  /** Writes records the types allow but the file format does not: what a clock change or a rounding bug leaves behind. */
  async function populateOutOfRange(store: TrainerStore): Promise<void> {
    await populate(store);
    await store.record({
      attempt: attempt({ at: NOW + 1, durationMs: -3 }),
      positions: [position("epd-c", { mastery: 1 + 1e-12, attempts: 2.6, srs: srs({ box: -1, dueAt: Number.NaN }) })],
      lines: [lineProgress("odd-line", { runs: -2, cleanRuns: Number.NaN, lastPracticedAt: Number.POSITIVE_INFINITY })]
    });
    await store.record({ attempt: attempt({ at: NOW + 2, durationMs: Number.NaN, hintsShown: 3 as AttemptRecord["hintsShown"] }) });
    await store.record({ positions: [position("epd-d", { mastery: Number.NaN })] });
  }

  it("repairs out-of-range values so the file imports again, and loses no record", async () => {
    const source = await freshStore();
    await populateOutOfRange(source);
    const backup = await source.exportBackup(NOW);
    const text = JSON.stringify(backup);

    for (const mode of ["replace", "merge"] as const) {
      const target = await freshStore();
      expect(await target.importBackup(text, { mode })).toEqual({ positions: 4, lines: 3, attempts: 5, customLines: 1, lineStates: 2 });
      expect(await target.exportBackup(NOW)).toEqual(backup);
    }

    const byEpd = Object.fromEntries(backup.positionProgress.map((progress) => [progress.epd, progress]));
    expect(byEpd["epd-c"]).toMatchObject({ mastery: 1, attempts: 3, srs: { box: 0, dueAt: null } });
    expect(byEpd["epd-d"].mastery).toBe(0);
    expect(backup.lineProgress.find((progress) => progress.lineId === "odd-line")).toMatchObject({ runs: 0, cleanRuns: 0, lastPracticedAt: null });
    expect(backup.attempts.slice(-2).map((record) => [record.durationMs, record.hintsShown])).toEqual([
      [null, 0],
      [null, 2]
    ]);
    // The valid records come out exactly as they were saved.
    expect(byEpd["epd-a"]).toEqual(position("epd-a", { lastPracticedAt: NOW - 2 * DAY_MS }));
  });

  it("refuses to make a backup that could not be imported again", async () => {
    const name = freshName();
    const store = await freshStore(name);
    await populate(store);
    await store.record({ attempt: attempt({ day: "1 October" }) });
    await store.putCustomLine(customLine(""));
    const error: unknown = await store.exportBackup(NOW).then(
      () => null,
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(BackupError);
    expect((error as BackupError).message).toBe(
      "Some saved data is damaged, so a backup cannot be made: attempts[3].day: expected a day as YYYY-MM-DD; customLines[0].id: Too small: expected string to have >=1 characters."
    );
    expect((error as BackupError).issues).toHaveLength(2);
    // Nothing is lost: the store still holds every record.
    expect((await rawCounts(name)).attempts).toBe(4);
  });
});

describe("importBackup (replace)", () => {
  it("restores an export exactly", async () => {
    const source = await freshStore();
    await populate(source);
    const backup = await source.exportBackup(NOW);

    const target = await freshStore();
    const summary = await target.importBackup(backup, { mode: "replace" });
    expect(summary).toEqual({ positions: 2, lines: 2, attempts: 3, customLines: 1, lineStates: 2 });
    expect(await target.exportBackup(NOW)).toEqual(backup);
    expect(await target.load({ attemptsSinceMs: 0 })).toEqual(await source.load({ attemptsSinceMs: 0 }));
  });

  it("restores from the file's JSON text", async () => {
    const source = await freshStore();
    await populate(source);
    const backup = await source.exportBackup(NOW);
    const target = await freshStore();
    await target.importBackup(JSON.stringify(backup, null, 2), { mode: "replace" });
    expect(await target.exportBackup(NOW)).toEqual(backup);
  });

  it("keeps attempt ids, and new attempts are numbered after them", async () => {
    const source = await freshStore();
    const ids = await populate(source);
    const target = await freshStore();
    await target.importBackup(await source.exportBackup(NOW), { mode: "replace" });
    expect((await target.listAttempts()).map((record) => record.id)).toEqual([...ids].reverse());
    const next = await target.record({ attempt: attempt({ at: NOW + 1 }) });
    expect(next).toBeGreaterThan(Math.max(...ids));
  });

  it("removes everything the backup does not contain", async () => {
    const source = await freshStore();
    await source.putLineStates([lineState("only-in-backup")]);
    const backup = await source.exportBackup(NOW);

    const target = await freshStore();
    await populate(target);
    await target.importBackup(backup, { mode: "replace" });
    expect(await target.load({ attemptsSinceMs: 0 })).toEqual({
      settings: DEFAULT_SETTINGS,
      lineStates: [lineState("only-in-backup")],
      positionProgress: [],
      lineProgress: [],
      customLines: [],
      recentAttempts: [],
      practiceDays: []
    });
  });

  it("gives attempts without an id a new one that no explicit id overwrites", async () => {
    const target = await freshStore();
    const backup = await (await freshStore()).exportBackup(NOW);
    const anonymous = attempt({ at: NOW, lineId: "anonymous" });
    const numbered = [{ ...attempt({ at: NOW - 2, lineId: "one" }), id: 1 }, { ...attempt({ at: NOW - 1, lineId: "two" }), id: 2 }];
    const summary = await target.importBackup({ ...backup, attempts: [anonymous, ...numbered] }, { mode: "replace" });
    expect(summary.attempts).toBe(3);
    expect((await target.listAttempts()).map((record) => [record.id, record.lineId])).toEqual([
      [3, "anonymous"],
      [2, "two"],
      [1, "one"]
    ]);
  });
});

describe("importBackup (merge)", () => {
  const OLD = NOW - 2 * DAY_MS;
  const MID = NOW - DAY_MS;

  it("keeps the progress record practised more recently", async () => {
    const store = await freshStore();
    await store.record({
      positions: [
        position("newer-in-backup", { lastPracticedAt: OLD, attempts: 1 }),
        position("newer-here", { lastPracticedAt: MID, attempts: 1 }),
        position("tie", { lastPracticedAt: MID, attempts: 1 }),
        position("never-here", { lastPracticedAt: null, attempts: 0 }),
        position("never-in-backup", { lastPracticedAt: OLD, attempts: 1 }),
        position("local-only", { attempts: 1 })
      ],
      lines: [lineProgress("line-old", { lastPracticedAt: OLD, runs: 1 }), lineProgress("line-new", { lastPracticedAt: MID, runs: 1 })]
    });
    const backup: BackupFile = {
      ...(await (await freshStore()).exportBackup(NOW)),
      positionProgress: [
        position("newer-in-backup", { lastPracticedAt: MID, attempts: 9 }),
        position("newer-here", { lastPracticedAt: OLD, attempts: 9 }),
        position("tie", { lastPracticedAt: MID, attempts: 9 }),
        position("never-here", { lastPracticedAt: OLD, attempts: 9 }),
        position("never-in-backup", { lastPracticedAt: null, attempts: 9 }),
        position("backup-only", { attempts: 9 })
      ],
      lineProgress: [lineProgress("line-old", { lastPracticedAt: MID, runs: 9 }), lineProgress("line-new", { lastPracticedAt: OLD, runs: 9 })]
    };

    const summary = await store.importBackup(backup, { mode: "merge" });
    expect(summary).toEqual({ positions: 3, lines: 1, attempts: 0, customLines: 0, lineStates: 0 });
    const attemptsByKey = Object.fromEntries((await store.load()).positionProgress.map((progress) => [progress.epd, progress.attempts]));
    expect(attemptsByKey).toEqual({
      "newer-in-backup": 9,
      "newer-here": 1,
      tie: 1,
      "never-here": 9,
      "never-in-backup": 1,
      "local-only": 1,
      "backup-only": 9
    });
    const runs = Object.fromEntries((await store.load()).lineProgress.map((progress) => [progress.lineId, progress.runs]));
    expect(runs).toEqual({ "line-old": 9, "line-new": 1 });
  });

  it("keeps the line state and custom line updated more recently", async () => {
    const store = await freshStore();
    await store.putLineStates([lineState("a", { enabled: true, updatedAt: OLD }), lineState("b", { enabled: true, updatedAt: MID })]);
    await store.putCustomLine(customLine("c1", { name: "Local", updatedAt: OLD }));
    await store.putCustomLine(customLine("c2", { name: "Local", updatedAt: MID }));
    const backup: BackupFile = {
      ...(await (await freshStore()).exportBackup(NOW)),
      lineStates: [
        lineState("a", { enabled: false, updatedAt: MID }),
        lineState("b", { enabled: false, updatedAt: MID }),
        lineState("c", { updatedAt: OLD })
      ],
      customLines: [customLine("c1", { name: "Backup", updatedAt: MID }), customLine("c2", { name: "Backup", updatedAt: OLD }), customLine("c3")]
    };
    const summary = await store.importBackup(backup, { mode: "merge" });
    expect(summary).toMatchObject({ lineStates: 2, customLines: 2 });
    const snapshot = await store.load();
    expect(snapshot.lineStates.map((state) => [state.lineId, state.enabled])).toEqual([
      ["a", false],
      ["b", true],
      ["c", true]
    ]);
    expect(snapshot.customLines.map((line) => [line.id, line.name])).toEqual([
      ["c1", "Backup"],
      ["c2", "Local"],
      ["c3", "Reversed Sicilian"]
    ]);
  });

  it("adds attempts that are not already here, with new ids, and is idempotent", async () => {
    const source = await freshStore();
    await populate(source);
    const backup = await source.exportBackup(NOW);

    const target = await freshStore();
    const localId = await target.record({ attempt: attempt({ at: NOW - 10 * DAY_MS, lineId: "local" }) });
    // The same attempt as the backup's first one, recorded here under another id.
    await target.record({ attempt: backup.attempts[0] });

    const first = await target.importBackup(backup, { mode: "merge" });
    expect(first.attempts).toBe(2);
    const all = await target.listAttempts();
    expect(all).toHaveLength(4);
    expect(new Set(all.map((record) => record.id)).size).toBe(4);
    expect(all.find((record) => record.id === localId)).toMatchObject({ lineId: "local" });

    const again = await target.importBackup(backup, { mode: "merge" });
    expect(again).toEqual({ positions: 0, lines: 0, attempts: 0, customLines: 0, lineStates: 0 });
    expect(await target.listAttempts()).toHaveLength(4);
    expect(await target.practiceDays()).toEqual([...new Set(all.map((record) => record.day))].sort());
  });

  it("keeps saved settings, and takes the backup's when none were saved", async () => {
    const source = await freshStore();
    await source.saveSettings(CUSTOM_SETTINGS);
    const backup = await source.exportBackup(NOW);

    const configured = await freshStore();
    const local = { ...DEFAULT_SETTINGS, sound: { enabled: false, volume: 0 } };
    await configured.saveSettings(local);
    await configured.importBackup(backup, { mode: "merge" });
    expect((await configured.load()).settings).toEqual(local);

    const fresh = await freshStore();
    await fresh.importBackup(backup, { mode: "merge" });
    expect((await fresh.load()).settings).toEqual(CUSTOM_SETTINGS);
  });

  it("merges a whole export into an empty store as a full restore", async () => {
    const source = await freshStore();
    await populate(source);
    const backup = await source.exportBackup(NOW);
    const target = await freshStore();
    expect(await target.importBackup(backup, { mode: "merge" })).toEqual({ positions: 2, lines: 2, attempts: 3, customLines: 1, lineStates: 2 });
    const restored = await target.exportBackup(NOW);
    expect(restored).toEqual(backup);
  });
});

describe("importBackup (rejected files)", () => {
  async function expectRejected(input: unknown, message: RegExp): Promise<void> {
    const name = freshName();
    const store = await freshStore(name);
    await populate(store);
    const before = await store.exportBackup(NOW);
    const countsBefore = await rawCounts(name);
    for (const mode of ["replace", "merge"] as const) {
      const error: unknown = await store.importBackup(input, { mode }).then(
        () => null,
        (reason: unknown) => reason
      );
      expect(error).toBeInstanceOf(BackupError);
      expect((error as BackupError).message).toMatch(message);
    }
    expect(await store.exportBackup(NOW)).toEqual(before);
    expect(await rawCounts(name)).toEqual(countsBefore);
  }

  async function validBackup(): Promise<BackupFile> {
    const store = await freshStore();
    await populate(store);
    return store.exportBackup(NOW);
  }

  it.each([null, 7, "not json {", "[]", [], { app: "lichess", format: 1 }, {}])("rejects %j as not a backup", async (input) => {
    await expectRejected(input, /not a backup of the opening trainer/);
  });

  it("rejects a backup from a newer format", async () => {
    await expectRejected({ ...(await validBackup()), format: 2 }, /newer version of the app \(format 2\)/);
  });

  it("rejects an unknown format", async () => {
    await expectRejected({ ...(await validBackup()), format: "1" }, /format this app does not know/);
  });

  it("rejects a damaged record and writes none of the valid ones", async () => {
    const backup = await validBackup();
    const damaged = { ...backup.positionProgress[1], srs: { ...backup.positionProgress[1].srs, box: "one" } };
    await expectRejected(
      { ...backup, lineStates: [...backup.lineStates, lineState("new-line")], positionProgress: [backup.positionProgress[0], damaged] },
      /damaged or incomplete.*positionProgress\[1\]\.srs\.box/
    );
  });

  it("rejects a missing store", async () => {
    const { attempts: _attempts, ...rest } = await validBackup();
    await expectRejected(rest, /attempts/);
  });

  it("rejects duplicate keys", async () => {
    const backup = await validBackup();
    const duplicated = { ...backup, customLines: [...backup.customLines, backup.customLines[0]] };
    await expectRejected(duplicated, /customLines\[1\]: the key "custom-1" appears more than once/);
  });
});

describe("resets", () => {
  it("resetProgress clears progress and attempts but keeps settings, line states and custom lines", async () => {
    const name = freshName();
    const store = await freshStore(name);
    await populate(store);
    const before = await store.load();
    await store.resetProgress();
    expect(await store.load()).toEqual({
      ...before,
      positionProgress: [],
      lineProgress: [],
      recentAttempts: [],
      practiceDays: []
    });
    expect(await rawCounts(name)).toEqual({ settings: 1, lineStates: 2, positionProgress: 0, lineProgress: 0, attempts: 0, customLines: 1, meta: 2 });
  });

  it("resetAll clears every store and stamps meta afresh", async () => {
    const name = freshName();
    const created = NOW - 30 * DAY_MS;
    const first = await openTrainerStore(name, { now: () => created });
    await populate(first);
    first.close();

    const store = await freshStore(name);
    await store.resetAll();
    expect(await store.load({ attemptsSinceMs: 0 })).toEqual(await (await freshStore()).load());
    expect(await rawCounts(name)).toEqual({ settings: 0, lineStates: 0, positionProgress: 0, lineProgress: 0, attempts: 0, customLines: 0, meta: 2 });
    const db = await openTrainerDb(name);
    expect(await db.get("meta", "createdAt")).toBe(NOW);
    expect(await db.get("meta", "schemaVersion")).toBe(1);
    db.close();

    expect(await store.record({ attempt: attempt() })).toBeTypeOf("number");
  });
});

describe("lifetime", () => {
  it("keeps everything across close and reopen", async () => {
    const name = freshName();
    const first = await openTrainerStore(name, { now: clock });
    await populate(first);
    const before = await first.load();
    first.close();
    const reopened = await freshStore(name);
    expect(await reopened.load()).toEqual(before);
  });

  it("rejects calls after close", async () => {
    const store = await openTrainerStore(freshName(), { now: clock });
    store.close();
    await expect(store.load()).rejects.toThrow();
    await expect(store.record({ attempt: attempt() })).rejects.toThrow();
  });

  it("opens the app's database by default", async () => {
    const store = await openTrainerStore();
    open.push(store);
    expect((await store.load()).settings).toEqual(DEFAULT_SETTINGS);
    const names = (await indexedDB.databases()).map((info) => info.name);
    expect(names).toContain("opening-trainer");
  });
});

describe("persist", () => {
  it("is false when the browser has no storage manager", async () => {
    vi.stubGlobal("navigator", {});
    expect(await (await freshStore()).persist()).toBe(false);
    vi.stubGlobal("navigator", undefined);
    expect(await (await freshStore()).persist()).toBe(false);
  });

  it("reports the browser's answer", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { storage: { persist } });
    expect(await (await freshStore()).persist()).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    vi.stubGlobal("navigator", { storage: { persist: async () => false } });
    expect(await (await freshStore()).persist()).toBe(false);
  });

  it("is false when the request fails", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        persist: async () => {
          throw new Error("denied");
        }
      }
    });
    expect(await (await freshStore()).persist()).toBe(false);
  });
});

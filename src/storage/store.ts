import type { IDBPObjectStore, IDBPTransaction } from "idb";
import type { AttemptRecord, CustomLineRecord, LineProgress, LineState, PositionProgress, Settings } from "../core/training/types";
import { DAY_MS } from "../core/util/time";
import { BACKUP_APP, BACKUP_FORMAT, parseBackup, prepareBackup, type BackupFile, type ImportSummary } from "./backup";
import {
  ALL_STORES,
  DATA_STORES,
  DB_VERSION,
  PROGRESS_STORES,
  SETTINGS_KEY,
  openTrainerDb,
  type TrainerDb,
  type TrainerDbSchema,
  type TrainerStoreName
} from "./db";
import { mergeSettings } from "./settings";

// The app's only gateway to IndexedDB. Every method is one transaction, so a write either lands
// completely or not at all (a failed practice record never leaves progress without its attempt,
// and a failed import never leaves half a backup). Reads return plain records; the training
// logic in src/core decides what they mean.

/** How far back load() reads attempts unless told otherwise, days. */
export const RECENT_ATTEMPTS_DAYS = 90;

export interface StoreSnapshot {
  /** Merged over DEFAULT_SETTINGS (deep, unknown keys dropped, numbers clamped). */
  settings: Settings;
  lineStates: LineState[];
  positionProgress: PositionProgress[];
  lineProgress: LineProgress[];
  customLines: CustomLineRecord[];
  /** Newest first, since `attemptsSinceMs`. */
  recentAttempts: AttemptRecord[];
  /** Every local day with at least one attempt (all time), ascending. */
  practiceDays: string[];
}

/** What one answered exercise changes, written together. */
export interface RecordInput {
  /** Its id is ignored: the store assigns one. */
  attempt?: AttemptRecord;
  positions?: PositionProgress[];
  lines?: LineProgress[];
}

export interface ListAttemptsOptions {
  /** Only attempts at or after this time, ms since the epoch. */
  sinceMs?: number;
  /** At most this many (the newest). */
  limit?: number;
  posKey?: string;
  lineId?: string;
}

export interface TrainerStore {
  /** Everything the app needs at start-up; attempts since `attemptsSinceMs` (ms since the epoch; default RECENT_ATTEMPTS_DAYS ago). */
  load(options?: { attemptsSinceMs?: number }): Promise<StoreSnapshot>;
  /** Saves the settings (normalised with mergeSettings first). */
  saveSettings(settings: Settings): Promise<void>;
  putLineStates(states: readonly LineState[]): Promise<void>;
  /** Writes progress and the attempt in ONE transaction; returns the new attempt's id (null without an attempt). */
  record(input: RecordInput): Promise<number | null>;
  /** Attempts newest first (ties: higher id first), filtered. */
  listAttempts(options?: ListAttemptsOptions): Promise<AttemptRecord[]>;
  /** Unique local day keys with at least one attempt, ascending (read from the by-day index keys). */
  practiceDays(): Promise<string[]>;
  putCustomLine(record: CustomLineRecord): Promise<void>;
  deleteCustomLine(id: string): Promise<void>;
  /**
   * Everything, checked against the format an import reads, so the file always imports again:
   * out-of-range numbers are repaired as an import repairs them (see backup.ts); a record damaged
   * beyond repair throws BackupError instead of producing a file that could not be restored.
   */
  exportBackup(now: number): Promise<BackupFile>;
  /**
   * Validates first (throws BackupError, writing nothing; out-of-range numbers are repaired, not
   * refused), then writes in one transaction.
   * replace: clears every data store, then writes the backup (attempt ids kept).
   * merge: per record the newer one wins (lastPracticedAt for progress, updatedAt for line states
   * and custom lines; a tie keeps the local record); attempts not already present are added with
   * new ids; local settings are kept, the backup's are used only when none were saved.
   */
  importBackup(backup: unknown, options: { mode: "replace" | "merge" }): Promise<ImportSummary>;
  /** Clears positionProgress, lineProgress and attempts; keeps settings, lineStates and customLines. */
  resetProgress(): Promise<void>;
  /** Clears every store (meta is stamped afresh). */
  resetAll(): Promise<void>;
  /** Asks the browser to keep the data under storage pressure; false when unsupported or refused. */
  persist(): Promise<boolean>;
  close(): void;
}

export interface OpenStoreOptions {
  /** The clock (ms) for the default attempts window and meta stamps; Date.now by default. */
  now?: () => number;
}

/** Opens the trainer's store (the database is created or upgraded on first use). */
export async function openTrainerStore(name?: string, options: OpenStoreOptions = {}): Promise<TrainerStore> {
  const now = options.now ?? Date.now;
  const db = await openTrainerDb(name, { now });
  return new IdbTrainerStore(db, now);
}

type WriteTransaction<Names extends ArrayLike<TrainerStoreName>> = IDBPTransaction<TrainerDbSchema, Names, "readwrite">;
type AttemptStore = IDBPObjectStore<TrainerDbSchema, ["attempts"], "attempts", "readonly">;

class IdbTrainerStore implements TrainerStore {
  constructor(
    private readonly db: TrainerDb,
    private readonly now: () => number
  ) {}

  async load(options: { attemptsSinceMs?: number } = {}): Promise<StoreSnapshot> {
    const sinceMs = options.attemptsSinceMs ?? this.now() - RECENT_ATTEMPTS_DAYS * DAY_MS;
    const tx = this.db.transaction(DATA_STORES, "readonly");
    const [stored, lineStates, positionProgress, lineProgress, customLines, attempts, practiceDays] = await Promise.all([
      tx.objectStore("settings").get(SETTINGS_KEY),
      tx.objectStore("lineStates").getAll(),
      tx.objectStore("positionProgress").getAll(),
      tx.objectStore("lineProgress").getAll(),
      tx.objectStore("customLines").getAll(),
      findAttempts(tx.objectStore("attempts"), { sinceMs }, Infinity),
      readPracticeDays(tx.objectStore("attempts").index("by-day").openKeyCursor(null, "nextunique")),
      tx.done
    ]);
    return {
      settings: mergeSettings(stored),
      lineStates,
      positionProgress,
      lineProgress,
      customLines,
      recentAttempts: attempts,
      practiceDays
    };
  }

  async saveSettings(settings: Settings): Promise<void> {
    await writeTransaction(this.db, ["settings"], (tx, batch) => {
      batch.add(tx.objectStore("settings").put(mergeSettings(settings), SETTINGS_KEY));
    });
  }

  async putLineStates(states: readonly LineState[]): Promise<void> {
    if (states.length === 0) {
      return;
    }
    await writeTransaction(this.db, ["lineStates"], (tx, batch) => {
      const store = tx.objectStore("lineStates");
      for (const state of states) {
        batch.add(store.put(state));
      }
    });
  }

  async record(input: RecordInput): Promise<number | null> {
    const positions = input.positions ?? [];
    const lines = input.lines ?? [];
    if (positions.length === 0 && lines.length === 0 && input.attempt === undefined) {
      return null;
    }
    return writeTransaction(this.db, PROGRESS_STORES, async (tx, batch) => {
      const positionStore = tx.objectStore("positionProgress");
      for (const progress of positions) {
        batch.add(positionStore.put(progress));
      }
      const lineStore = tx.objectStore("lineProgress");
      for (const progress of lines) {
        batch.add(lineStore.put(progress));
      }
      return input.attempt === undefined ? null : batch.add(tx.objectStore("attempts").add(withoutId(input.attempt)));
    });
  }

  async listAttempts(options: ListAttemptsOptions = {}): Promise<AttemptRecord[]> {
    const limit = options.limit === undefined ? Infinity : Math.max(0, Math.floor(options.limit));
    if (limit === 0) {
      return [];
    }
    const tx = this.db.transaction("attempts", "readonly");
    const [found] = await Promise.all([findAttempts(tx.store, options, limit), tx.done]);
    return found;
  }

  async practiceDays(): Promise<string[]> {
    const tx = this.db.transaction("attempts", "readonly");
    const [days] = await Promise.all([readPracticeDays(tx.store.index("by-day").openKeyCursor(null, "nextunique")), tx.done]);
    return days;
  }

  async putCustomLine(record: CustomLineRecord): Promise<void> {
    await writeTransaction(this.db, ["customLines"], (tx, batch) => {
      batch.add(tx.objectStore("customLines").put(record));
    });
  }

  async deleteCustomLine(id: string): Promise<void> {
    await writeTransaction(this.db, ["customLines"], (tx, batch) => {
      batch.add(tx.objectStore("customLines").delete(id));
    });
  }

  async exportBackup(now: number): Promise<BackupFile> {
    const tx = this.db.transaction(DATA_STORES, "readonly");
    const [stored, lineStates, positionProgress, lineProgress, attempts, customLines] = await Promise.all([
      tx.objectStore("settings").get(SETTINGS_KEY),
      tx.objectStore("lineStates").getAll(),
      tx.objectStore("positionProgress").getAll(),
      tx.objectStore("lineProgress").getAll(),
      tx.objectStore("attempts").getAll(),
      tx.objectStore("customLines").getAll(),
      tx.done
    ]);
    return prepareBackup({
      app: BACKUP_APP,
      format: BACKUP_FORMAT,
      exportedAt: now,
      settings: mergeSettings(stored),
      lineStates,
      positionProgress,
      lineProgress,
      attempts,
      customLines
    });
  }

  async importBackup(input: unknown, options: { mode: "replace" | "merge" }): Promise<ImportSummary> {
    const backup = parseBackup(input);
    if (options.mode === "replace") {
      return writeTransaction(this.db, DATA_STORES, (tx, batch) => replaceWith(tx, batch, backup));
    }
    return writeTransaction(this.db, DATA_STORES, (tx, batch) => mergeIn(tx, batch, backup));
  }

  async resetProgress(): Promise<void> {
    await writeTransaction(this.db, PROGRESS_STORES, (tx, batch) => {
      for (const name of PROGRESS_STORES) {
        batch.add(tx.objectStore(name).clear());
      }
    });
  }

  async resetAll(): Promise<void> {
    await writeTransaction(this.db, ALL_STORES, (tx, batch) => {
      for (const name of ALL_STORES) {
        batch.add(tx.objectStore(name).clear());
      }
      const meta = tx.objectStore("meta");
      batch.add(meta.put(DB_VERSION, "schemaVersion"));
      batch.add(meta.put(this.now(), "createdAt"));
    });
  }

  async persist(): Promise<boolean> {
    const storage = typeof navigator === "undefined" ? undefined : (navigator.storage as StorageManager | undefined);
    if (typeof storage?.persist !== "function") {
      return false;
    }
    try {
      return await storage.persist();
    } catch {
      return false;
    }
  }

  close(): void {
    this.db.close();
  }
}

/**
 * The requests of one transaction. Each rejection is observed as it is queued, so when one write
 * fails (and the transaction is aborted) the caller sees that one error and no unhandled rejections.
 */
class Batch {
  private readonly requests: Promise<unknown>[] = [];

  add<T>(request: Promise<T>): Promise<T> {
    request.catch(ignore);
    this.requests.push(request);
    return request;
  }

  settled(): Promise<unknown[]> {
    return Promise.all(this.requests);
  }
}

/**
 * Runs `work` in one readwrite transaction. `work` must only queue IndexedDB requests (through
 * `batch`) or await them; on any failure, a synchronous throw included (DataCloneError,
 * DataError), the transaction is aborted so nothing it wrote remains.
 */
async function writeTransaction<Names extends ArrayLike<TrainerStoreName>, T>(
  db: TrainerDb,
  stores: Names,
  work: (tx: WriteTransaction<Names>, batch: Batch) => T | Promise<T>
): Promise<T> {
  const tx = db.transaction(stores, "readwrite");
  const done = tx.done;
  done.catch(ignore);
  const batch = new Batch();
  try {
    const result = await work(tx, batch);
    await batch.settled();
    await done;
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // Already aborted by the failed request (or finished): nothing left to undo.
    }
    await done.catch(ignore);
    throw error;
  }
}

function replaceWith(tx: WriteTransaction<typeof DATA_STORES>, batch: Batch, backup: BackupFile): ImportSummary {
  // Requests run in the order they are queued, so every clear happens before the first write.
  for (const name of DATA_STORES) {
    batch.add(tx.objectStore(name).clear());
  }
  batch.add(tx.objectStore("settings").put(backup.settings, SETTINGS_KEY));
  putAll(batch, tx.objectStore("lineStates"), backup.lineStates);
  putAll(batch, tx.objectStore("positionProgress"), backup.positionProgress);
  putAll(batch, tx.objectStore("lineProgress"), backup.lineProgress);
  putAll(batch, tx.objectStore("customLines"), backup.customLines);
  // Explicit ids are kept (each moves the key generator past it). Attempts without one go last, so
  // the ids generated for them cannot collide with (and be overwritten by) an explicit one.
  const attemptStore = tx.objectStore("attempts");
  putAll(batch, attemptStore, backup.attempts.filter((attempt) => attempt.id !== undefined));
  putAll(batch, attemptStore, backup.attempts.filter((attempt) => attempt.id === undefined));
  return {
    positions: backup.positionProgress.length,
    lines: backup.lineProgress.length,
    attempts: backup.attempts.length,
    customLines: backup.customLines.length,
    lineStates: backup.lineStates.length
  };
}

async function mergeIn(tx: WriteTransaction<typeof DATA_STORES>, batch: Batch, backup: BackupFile): Promise<ImportSummary> {
  const settingsStore = tx.objectStore("settings");
  const lineStateStore = tx.objectStore("lineStates");
  const positionStore = tx.objectStore("positionProgress");
  const lineStore = tx.objectStore("lineProgress");
  const customStore = tx.objectStore("customLines");
  const attemptStore = tx.objectStore("attempts");
  const [storedSettings, lineStates, positions, lines, customLines, attempts] = await Promise.all([
    batch.add(settingsStore.get(SETTINGS_KEY)),
    batch.add(lineStateStore.getAll()),
    batch.add(positionStore.getAll()),
    batch.add(lineStore.getAll()),
    batch.add(customStore.getAll()),
    batch.add(attemptStore.getAll())
  ]);

  if (storedSettings === undefined) {
    batch.add(settingsStore.put(backup.settings, SETTINGS_KEY));
  }
  const newerLineStates = newerRecords(backup.lineStates, lineStates, (state) => state.lineId, (state) => state.updatedAt);
  const newerPositions = newerRecords(backup.positionProgress, positions, (progress) => progress.key, (progress) => progress.lastPracticedAt);
  const newerLines = newerRecords(backup.lineProgress, lines, (progress) => progress.lineId, (progress) => progress.lastPracticedAt);
  const newerCustomLines = newerRecords(backup.customLines, customLines, (line) => line.id, (line) => line.updatedAt);
  putAll(batch, lineStateStore, newerLineStates);
  putAll(batch, positionStore, newerPositions);
  putAll(batch, lineStore, newerLines);
  putAll(batch, customStore, newerCustomLines);

  // Attempts are a log: two devices number theirs independently, so an imported attempt is added
  // with a new id unless the same attempt (same time, mode, side, position and line) is present.
  const known = new Set(attempts.map(attemptIdentity));
  let addedAttempts = 0;
  for (const attempt of backup.attempts) {
    const identity = attemptIdentity(attempt);
    if (!known.has(identity)) {
      known.add(identity);
      batch.add(attemptStore.add(withoutId(attempt)));
      addedAttempts += 1;
    }
  }
  return {
    positions: newerPositions.length,
    lines: newerLines.length,
    attempts: addedAttempts,
    customLines: newerCustomLines.length,
    lineStates: newerLineStates.length
  };
}

/** The incoming records that are new here or strictly newer than the local one (a missing time counts as oldest). */
function newerRecords<T>(incoming: readonly T[], local: readonly T[], keyOf: (record: T) => string, timeOf: (record: T) => number | null): T[] {
  const localByKey = new Map(local.map((record) => [keyOf(record), record]));
  return incoming.filter((record) => {
    const existing = localByKey.get(keyOf(record));
    return existing === undefined || (timeOf(record) ?? -Infinity) > (timeOf(existing) ?? -Infinity);
  });
}

function putAll<T>(batch: Batch, store: { put(value: T): Promise<unknown> }, records: readonly T[]): void {
  for (const record of records) {
    batch.add(store.put(record));
  }
}

async function findAttempts(store: AttemptStore, options: ListAttemptsOptions, limit: number): Promise<AttemptRecord[]> {
  const { posKey, lineId, sinceMs } = options;
  if (posKey !== undefined || lineId !== undefined) {
    // The narrower index first (a position belongs to few lines), the other filters in memory.
    const candidates = posKey !== undefined ? await store.index("by-pos").getAll(posKey) : await store.index("by-line").getAll(lineId);
    return candidates
      .filter((attempt) => (sinceMs === undefined || attempt.at >= sinceMs) && (lineId === undefined || attempt.lineId === lineId))
      .sort(newestFirst)
      .slice(0, limit);
  }
  // The by-at index orders by time, then id: read backwards, that is newest first with ties by higher id.
  const range = sinceMs === undefined ? null : IDBKeyRange.lowerBound(sinceMs);
  if (limit === Infinity) {
    return (await store.index("by-at").getAll(range)).reverse();
  }
  const found: AttemptRecord[] = [];
  let cursor = await store.index("by-at").openCursor(range, "prev");
  while (cursor && found.length < limit) {
    found.push(cursor.value);
    cursor = found.length < limit ? await cursor.continue() : null;
  }
  return found;
}

interface DayKeyCursor {
  key: string;
  continue(): Promise<DayKeyCursor | null>;
}

/** Walks the by-day index keys once each ("nextunique"), so no attempt record is read. */
async function readPracticeDays(opening: Promise<DayKeyCursor | null>): Promise<string[]> {
  const days: string[] = [];
  let cursor = await opening;
  while (cursor) {
    days.push(cursor.key);
    cursor = await cursor.continue();
  }
  return days;
}

function attemptIdentity(attempt: AttemptRecord): string {
  return [attempt.at, attempt.mode, attempt.side, attempt.posKey ?? "", attempt.lineId ?? ""].join("|");
}

function newestFirst(a: AttemptRecord, b: AttemptRecord): number {
  return b.at - a.at || (b.id ?? 0) - (a.id ?? 0);
}

function withoutId(attempt: AttemptRecord): AttemptRecord {
  const copy = { ...attempt };
  delete copy.id;
  return copy;
}

function ignore(): void {
  // Observed elsewhere: see Batch and writeTransaction.
}

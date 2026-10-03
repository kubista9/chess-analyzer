import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from "idb";
import type { Color } from "../core/chess/position";
import type { AttemptRecord, CustomLineRecord, LineProgress, LineState, PositionProgress } from "../core/training/types";

// The IndexedDB schema of the trainer. Everything the user owns lives here, on their device only:
// settings, line choices, progress, the attempt log and their own lines. The store (store.ts) is
// the only reader and writer; this module creates the database and migrates it between versions.

/** The database name the app uses. */
export const DB_NAME = "opening-trainer";

/** The schema version. Bump it, and add a case to upgradeTrainerDb, for every change of stores or indexes. */
export const DB_VERSION = 1;

/** The key of the one record in the settings store. */
export const SETTINGS_KEY = "settings";

export interface TrainerDbSchema extends DBSchema {
  /** One record under SETTINGS_KEY: the settings as last saved. Read it through mergeSettings (an older build may have saved other keys). */
  settings: { key: typeof SETTINGS_KEY; value: unknown };
  lineStates: { key: string; value: LineState };
  positionProgress: { key: string; value: PositionProgress; indexes: { "by-side": Color } };
  lineProgress: { key: string; value: LineProgress };
  /** Records without a posKey or lineId are simply absent from by-pos or by-line (null is not an IndexedDB key). */
  attempts: { key: number; value: AttemptRecord; indexes: { "by-at": number; "by-day": string; "by-pos": string; "by-line": string } };
  customLines: { key: string; value: CustomLineRecord };
  /** schemaVersion: the version that last upgraded the database; createdAt: ms. */
  meta: { key: "schemaVersion" | "createdAt"; value: number };
}

export type TrainerDb = IDBPDatabase<TrainerDbSchema>;
export type TrainerStoreName = StoreNames<TrainerDbSchema>;
export type UpgradeTransaction = IDBPTransaction<TrainerDbSchema, TrainerStoreName[], "versionchange">;

/** The stores that hold the user's data (everything but meta), in a fixed order. */
export const DATA_STORES = ["settings", "lineStates", "positionProgress", "lineProgress", "attempts", "customLines"] as const;
/** The stores that practice writes and resetProgress clears. */
export const PROGRESS_STORES = ["positionProgress", "lineProgress", "attempts"] as const;
/** Every store. */
export const ALL_STORES = [...DATA_STORES, "meta"] as const;

export interface OpenDbOptions {
  /** The clock for createdAt (ms); Date.now by default. */
  now?: () => number;
}

/** Opens (creating or upgrading as needed) the trainer database. */
export async function openTrainerDb(name: string = DB_NAME, options: OpenDbOptions = {}): Promise<TrainerDb> {
  const now = options.now ?? Date.now;
  return openDB<TrainerDbSchema>(name, DB_VERSION, {
    upgrade(database, oldVersion, newVersion, transaction) {
      upgradeTrainerDb(database, transaction, oldVersion, newVersion ?? DB_VERSION, now());
    },
    // Another tab is opening a newer version: let it upgrade instead of leaving it blocked. This
    // tab's later reads and writes then fail until it is reloaded with the new code.
    blocking(_currentVersion, _blockedVersion, event) {
      (event.target as IDBDatabase).close();
    }
  });
}

/**
 * Brings a database from `oldVersion` to `newVersion`. Each case migrates one version to the
 * next and falls through to the following one, so a database several versions behind runs every
 * step in order. Steps only use `transaction` (never another promise), so the upgrade stays atomic.
 */
export function upgradeTrainerDb(database: TrainerDb, transaction: UpgradeTransaction, oldVersion: number, newVersion: number, now: number): void {
  switch (oldVersion) {
    case 0:
      createVersion1(database, transaction, now);
    // Falls through. Version 2 adds `case 1:` here (createIndex, or rewriting records through
    // `transaction`), version 3 adds `case 2:` after it, and so on.
  }
  settle(transaction.objectStore("meta").put(newVersion, "schemaVersion"));
}

function createVersion1(database: TrainerDb, transaction: UpgradeTransaction, now: number): void {
  database.createObjectStore("settings");
  database.createObjectStore("lineStates", { keyPath: "lineId" });
  const positions = database.createObjectStore("positionProgress", { keyPath: "key" });
  positions.createIndex("by-side", "side");
  database.createObjectStore("lineProgress", { keyPath: "lineId" });
  const attempts = database.createObjectStore("attempts", { keyPath: "id", autoIncrement: true });
  attempts.createIndex("by-at", "at");
  attempts.createIndex("by-day", "day");
  attempts.createIndex("by-pos", "posKey");
  attempts.createIndex("by-line", "lineId");
  database.createObjectStore("customLines", { keyPath: "id" });
  database.createObjectStore("meta");
  settle(transaction.objectStore("meta").put(now, "createdAt"));
}

// A failed write inside the upgrade aborts it, and openDB rejects with that error; the request's
// own rejection needs no second report.
function settle(request: Promise<unknown>): void {
  request.catch(() => undefined);
}

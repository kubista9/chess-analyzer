import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { runMigrations } from "./migrations.js";

export type Db = Database.Database;

export interface OpenOptions {
  /** Open an existing database without migrating or writing (verify scripts). */
  readonly?: boolean;
}

/** Opens (and, unless read-only, migrates) a database. ":memory:" works for tests. */
export function openDatabase(filePath: string, options: OpenOptions = {}): Db {
  if (options.readonly) {
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    return db;
  }

  if (filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const db = new Database(filePath);
  if (filePath !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  runMigrations(db);
  return db;
}

let shared: Db | null = null;

/** The app's database (storage/chess.db), opened and migrated on first use. */
export function getDb(): Db {
  shared ??= openDatabase(config.dbPath);
  return shared;
}

export function closeDb(): void {
  shared?.close();
  shared = null;
}

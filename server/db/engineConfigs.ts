import { canonicalJson } from "../engine/protocol.js";
import type { Db } from "./connection.js";

// Engine configs: one row per (engine version, protocol). The row id keys every stored
// engine result, so a new binary or a protocol change starts a clean set of results and
// re-queues the window's games, while old rows are kept.

export interface EngineConfig {
  id: number;
  engineName: string;
  engineVersion: string;
  protocolJson: string;
  openingPlies: number;
  createdAt: number;
}

interface EngineConfigRow {
  id: number;
  engine_name: string;
  engine_version: string;
  protocol_json: string;
  opening_plies: number;
  created_at: number;
}

function toConfig(row: EngineConfigRow): EngineConfig {
  return {
    id: row.id,
    engineName: row.engine_name,
    engineVersion: row.engine_version,
    protocolJson: row.protocol_json,
    openingPlies: row.opening_plies,
    createdAt: row.created_at
  };
}

export interface EngineConfigKey {
  engineName: string;
  engineVersion: string;
  protocol: unknown;
  openingPlies: number;
}

/** Returns the config for (engine version, protocol), creating it on first use. */
export function getOrCreateEngineConfig(db: Db, key: EngineConfigKey, now = Date.now()): EngineConfig {
  const protocolJson = canonicalJson(key.protocol);
  const select = db.prepare("SELECT * FROM engine_configs WHERE engine_version = ? AND protocol_json = ?");
  return db.transaction(() => {
    const existing = select.get(key.engineVersion, protocolJson) as EngineConfigRow | undefined;
    if (existing) {
      return toConfig(existing);
    }
    db.prepare(
      `INSERT INTO engine_configs (engine_name, engine_version, protocol_json, opening_plies, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(key.engineName, key.engineVersion, protocolJson, key.openingPlies, now);
    return toConfig(select.get(key.engineVersion, protocolJson) as EngineConfigRow);
  }).immediate();
}

export function getEngineConfig(db: Db, id: number): EngineConfig | undefined {
  const row = db.prepare("SELECT * FROM engine_configs WHERE id = ?").get(id) as EngineConfigRow | undefined;
  return row ? toConfig(row) : undefined;
}

export function listEngineConfigs(db: Db): EngineConfig[] {
  return (db.prepare("SELECT * FROM engine_configs ORDER BY id").all() as EngineConfigRow[]).map(toConfig);
}

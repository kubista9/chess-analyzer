import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import type { Db } from "../db/connection.js";
import { getOrCreateEngineConfig, type EngineConfig, type EngineConfigKey } from "../db/engineConfigs.js";
import { ENGINE_PROTOCOL, type EngineProtocol } from "./protocol.js";
import { parseEngineId } from "./uci.js";

/** The config key for an engine's UCI `id name` under a protocol. */
export function engineConfigKey(idName: string, protocol: EngineProtocol = ENGINE_PROTOCOL): EngineConfigKey {
  const { name, version } = parseEngineId(idName);
  return { engineName: name, engineVersion: version, protocol, openingPlies: OPENING_PLY_LIMIT };
}

/** The current engine config (detected engine version + the search protocol), created on first use. */
export function currentEngineConfig(db: Db, idName: string, protocol: EngineProtocol = ENGINE_PROTOCOL): EngineConfig {
  return getOrCreateEngineConfig(db, engineConfigKey(idName, protocol));
}

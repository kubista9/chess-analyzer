import { config } from "../config.js";
import { EnginePool } from "./pool.js";
import { ENGINE_PROTOCOL } from "./protocol.js";
import { UciEngine, type UciEngineOptions } from "./uci.js";

// The process's engine pool: ENGINE_WORKERS single-thread Stockfish workers, started lazily
// on first use. The server closes it on SIGINT/SIGTERM (tsx watch restarts on every edit),
// so no engine outlives the process that started it.

export function engineOptions(): UciEngineOptions {
  return { path: config.stockfishPath, threads: ENGINE_PROTOCOL.threads, hashMb: ENGINE_PROTOCOL.hashMb };
}

let shared: EnginePool | null = null;

export function getEnginePool(): EnginePool {
  shared ??= new EnginePool({ size: config.engineWorkers, spawn: () => UciEngine.start(engineOptions()) });
  return shared;
}

export async function closeEnginePool(): Promise<void> {
  const pool = shared;
  shared = null;
  await pool?.close();
}

let installed = false;

/** Closes the engines on SIGINT/SIGTERM and kills them on any other exit. */
export function installEngineShutdown(): void {
  if (installed) {
    return;
  }
  installed = true;
  const shutdown = (signal: NodeJS.Signals) => {
    void closeEnginePool().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("exit", () => shared?.killAll());
}

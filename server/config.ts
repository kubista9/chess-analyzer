import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER_USERNAME } from "../shared/constants.js";

// Anchor every storage path to the repo root, not process.cwd(), so the server, CLI and
// verify scripts share one storage/ no matter where they are started from. Walking up to
// the nearest package.json works from server/config.ts (tsx) and dist/server/config.js.
export function findRepoRoot(startDir: string): string {
  let dir = startDir;

  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`No package.json found above ${startDir}`);
    }
    dir = parent;
  }

  return dir;
}

const rootDir = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

// Load .env here (not via a CLI flag) so every entry point that imports config gets it.
// Variables already set in the environment win over the file.
const envFile = path.join(rootDir, ".env");
if (typeof process.loadEnvFile === "function" && fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/** ENGINE_WORKERS: 1-8, default 3. */
export function parseEngineWorkers(value: string | undefined): number {
  const parsed = Number(value?.trim() || 3);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(8, parsed)) : 3;
}

/** "1", "true", "yes", "on" (any case) are true; anything else is false. */
export function parseFlag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export const config = {
  rootDir,
  // The one Chess.com account this app analyses. CHESS_OWNER is for tests only.
  owner: (process.env.CHESS_OWNER ?? OWNER_USERNAME).trim().toLowerCase(),
  port: Number(process.env.PORT ?? 3001),
  // Loopback by default: the API has no auth and can start long engine jobs.
  // Set HOST=0.0.0.0 to opt in to LAN exposure.
  host: process.env.HOST?.trim() || "127.0.0.1",
  stockfishPath: process.env.STOCKFISH_PATH ?? path.join(rootDir, "storage", "engines", "stockfish", "current", "stockfish"),
  cacheDir: path.join(rootDir, "storage", "cache"),
  // The SQLite game store (archive months, games, opening plies). Safe to delete and re-sync.
  dbPath: path.join(rootDir, "storage", "chess.db"),
  // The vendored lichess chess-openings TSVs (read-only, CC0).
  openingBookDir: path.join(rootDir, "data", "chess-openings"),
  publicDistDir: path.join(rootDir, "dist", "web"),
  userAgent:
    process.env.CHESS_COM_USER_AGENT ??
    "chess-analyst-local/0.1 (contact: local-user@localhost)",
  // Single-thread Stockfish workers in the engine pool (the M1 has 4 performance cores).
  // Threads, Hash and the search depth are part of the engine protocol (server/engine/protocol.ts).
  engineWorkers: parseEngineWorkers(process.env.ENGINE_WORKERS),
  // One engine backfill at a time across the server and `npm run backfill`.
  backfillLockPath: path.join(rootDir, "storage", "backfill.lock"),
  // AUTO_BACKFILL=1: after each sync in the server, analyse the new games (on mains power only).
  autoBackfill: parseFlag(process.env.AUTO_BACKFILL)
};

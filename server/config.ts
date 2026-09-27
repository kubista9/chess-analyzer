import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
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
  publicDistDir: path.join(rootDir, "dist", "web"),
  userAgent:
    process.env.CHESS_COM_USER_AGENT ??
    "chess-analyst-local/0.1 (contact: local-user@localhost)",
  // Interim review: one movetime search per position (P4 replaces this protocol).
  reviewMoveTimeMs: Number(process.env.REVIEW_MOVE_TIME_MS ?? 360),
  stockfishThreads: Math.max(1, Math.min(4, Number(process.env.STOCKFISH_THREADS ?? os.cpus().length - 1))),
  stockfishHashMb: Math.max(32, Number(process.env.STOCKFISH_HASH_MB ?? 192))
};

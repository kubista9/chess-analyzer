import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

export const config = {
  rootDir,
  port: Number(process.env.PORT ?? 3001),
  stockfishPath: process.env.STOCKFISH_PATH ?? path.join(rootDir, "storage", "engines", "stockfish", "current", "stockfish"),
  cacheDir: path.join(rootDir, "storage", "cache"),
  publicDistDir: path.join(rootDir, "dist", "web"),
  userAgent:
    process.env.CHESS_COM_USER_AGENT ??
    "chess-analyst-local/0.1 (contact: local-user@localhost)",
  batchMoveTimeMs: Number(process.env.BATCH_MOVE_TIME_MS ?? 110),
  batchReplyTimeMs: Number(process.env.BATCH_REPLY_TIME_MS ?? 65),
  reviewMoveTimeMs: Number(process.env.REVIEW_MOVE_TIME_MS ?? 360),
  reviewReplyTimeMs: Number(process.env.REVIEW_REPLY_TIME_MS ?? 180),
  stockfishThreads: Math.max(1, Math.min(4, Number(process.env.STOCKFISH_THREADS ?? os.cpus().length - 1))),
  stockfishHashMb: Math.max(32, Number(process.env.STOCKFISH_HASH_MB ?? 192))
};

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs/promises";
import type { LegacyEngineLine } from "../../shared/types.js";
import { config } from "../config.js";

interface AnalyzeOptions {
  fen: string;
  multiPv: number;
  moveTimeMs: number;
  searchMoves?: string[];
}

interface EngineScore {
  cp: number;
  mate: number | null;
}

function parseScore(tokens: string[]): EngineScore | null {
  const scoreIndex = tokens.indexOf("score");
  if (scoreIndex === -1 || scoreIndex + 2 >= tokens.length) {
    return null;
  }

  const kind = tokens[scoreIndex + 1];
  const rawValue = Number(tokens[scoreIndex + 2]);
  if (!Number.isFinite(rawValue)) {
    return null;
  }

  if (kind === "cp") {
    return { cp: rawValue, mate: null };
  }

  if (kind === "mate") {
    const cp = rawValue > 0 ? 100000 - rawValue * 1000 : -100000 - rawValue * 1000;
    return { cp, mate: rawValue };
  }

  return null;
}

export interface StockfishSessionOptions {
  path?: string;
  args?: string[];
}

// Interim wrapper (P4a rewrites it). If the engine process fails to start, exits or errors,
// every pending search and readiness wait rejects, so a review job fails instead of hanging.
export class StockfishSession {
  private process: ChildProcessWithoutNullStreams;
  private lines: readline.Interface;
  private readonly path: string;
  private failure: Error | null = null;
  private closed = false;
  private readyWaiters = new Set<(error: Error) => void>();
  private pending:
    | {
        resolve: (value: LegacyEngineLine[]) => void;
        reject: (error: Error) => void;
        lines: Map<number, LegacyEngineLine>;
      }
    | null = null;

  constructor(options: StockfishSessionOptions = {}) {
    this.path = options.path ?? config.stockfishPath;
    this.process = spawn(this.path, options.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.lines = readline.createInterface({ input: this.process.stdout });
    this.process.on("error", (error) => this.fail(new Error(`Stockfish failed: ${error.message}`)));
    this.process.on("exit", (code, signal) =>
      this.fail(new Error(`Stockfish exited unexpectedly (${signal ? `signal ${signal}` : `code ${code}`})`))
    );
    // Writes after the process died emit EPIPE here; the exit handler reports the failure.
    this.process.stdin.on("error", (error) => this.fail(new Error(`Stockfish input failed: ${error.message}`)));
    this.bindOutput();
  }

  /** Rejects everything that waits on the engine. The first failure wins. */
  private fail(error: Error): void {
    if (this.closed) {
      return;
    }
    this.failure ??= error;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(this.failure);
    for (const reject of this.readyWaiters) {
      reject(this.failure);
    }
    this.readyWaiters.clear();
  }

  private bindOutput(): void {
    this.process.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      if (text.trim()) {
        console.warn(`[stockfish] ${text}`);
      }
    });

    this.lines.on("line", (line) => {
      if (!this.pending) {
        return;
      }

      if (line.startsWith("info ") && line.includes(" pv ")) {
        const tokens = line.trim().split(/\s+/);
        const multiPvIndex = tokens.indexOf("multipv");
        const pvIndex = tokens.indexOf("pv");
        const score = parseScore(tokens);

        if (pvIndex === -1 || !score) {
          return;
        }

        const rank = multiPvIndex === -1 ? 1 : Number(tokens[multiPvIndex + 1]);
        const pv = tokens.slice(pvIndex + 1);
        const move = pv[0];

        if (!move) {
          return;
        }

        this.pending.lines.set(rank, {
          move,
          scoreCp: score.cp,
          mate: score.mate,
          pv
        });
        return;
      }

      if (line.startsWith("bestmove")) {
        const result = [...this.pending.lines.entries()]
          .sort((left, right) => left[0] - right[0])
          .map((entry) => entry[1]);
        const pending = this.pending;
        this.pending = null;
        pending.resolve(result);
      }
    });
  }

  private send(command: string): void {
    if (this.failure) {
      throw this.failure;
    }
    this.process.stdin.write(`${command}\n`);
  }

  async initialize(): Promise<void> {
    await fs.access(this.path);

    this.send("uci");
    this.send(`setoption name Threads value ${config.stockfishThreads}`);
    this.send(`setoption name Hash value ${config.stockfishHashMb}`);
    await this.ready();
  }

  private ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }

      const onLine = (line: string) => {
        if (line.trim() === "readyok") {
          this.lines.off("line", onLine);
          this.readyWaiters.delete(onFailure);
          resolve();
        }
      };
      const onFailure = (error: Error) => {
        this.lines.off("line", onLine);
        reject(error);
      };

      this.readyWaiters.add(onFailure);
      this.lines.on("line", onLine);
      this.send("isready");
    });
  }

  async analyzePosition(options: AnalyzeOptions): Promise<LegacyEngineLine[]> {
    if (this.pending) {
      throw new Error("Stockfish session is already busy");
    }

    await this.ready();
    this.send("ucinewgame");
    this.send(`setoption name MultiPV value ${options.multiPv}`);
    this.send(`position fen ${options.fen}`);

    return new Promise<LegacyEngineLine[]>((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      this.pending = {
        resolve,
        reject,
        lines: new Map()
      };

      const searchMoves = options.searchMoves?.length ? ` searchmoves ${options.searchMoves.join(" ")}` : "";
      this.send(`go movetime ${options.moveTimeMs}${searchMoves}`);
    });
  }

  close(): void {
    this.closed = true;
    this.lines.close();
    this.process.kill();
  }
}

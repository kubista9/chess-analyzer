import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs/promises";
import type { EngineLine } from "../../shared/types.js";
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

export class StockfishSession {
  private process: ChildProcessWithoutNullStreams;
  private lines: readline.Interface;
  private pending:
    | {
        resolve: (value: EngineLine[]) => void;
        reject: (error: Error) => void;
        lines: Map<number, EngineLine>;
      }
    | null = null;

  constructor() {
    this.process = spawn(config.stockfishPath, [], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.lines = readline.createInterface({ input: this.process.stdout });
    this.bindOutput();
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
    this.process.stdin.write(`${command}\n`);
  }

  async initialize(): Promise<void> {
    await fs.access(config.stockfishPath);

    this.send("uci");
    this.send(`setoption name Threads value ${config.stockfishThreads}`);
    this.send(`setoption name Hash value ${config.stockfishHashMb}`);
    await this.ready();
  }

  private ready(): Promise<void> {
    return new Promise((resolve) => {
      const onLine = (line: string) => {
        if (line.trim() === "readyok") {
          this.lines.off("line", onLine);
          resolve();
        }
      };

      this.lines.on("line", onLine);
      this.send("isready");
    });
  }

  async analyzePosition(options: AnalyzeOptions): Promise<EngineLine[]> {
    if (this.pending) {
      throw new Error("Stockfish session is already busy");
    }

    await this.ready();
    this.send("ucinewgame");
    this.send(`setoption name MultiPV value ${options.multiPv}`);
    this.send(`position fen ${options.fen}`);

    return new Promise<EngineLine[]>((resolve, reject) => {
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
    this.lines.close();
    this.process.kill();
  }
}

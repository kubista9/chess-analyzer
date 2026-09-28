import { scoreWinPercent } from "../shared/eval.js";
import type { EngineLine } from "../shared/types.js";
import { replayUci } from "../server/engine/analysePosition.js";
import { EnginePool, type PoolEngine } from "../server/engine/pool.js";
import { EngineCrashedError, type SearchRequest, type SearchResult } from "../server/engine/uci.js";

// An in-memory engine for service tests: legal moves, deterministic scores. The main search
// returns the first `multipv` legal moves (in chess.js order) at +20, +10, 0 cp...; a
// searchmoves follow-up scores each move at -40 cp. Every search is logged.

export interface FakeSearch {
  moves: readonly string[];
  multipv: number;
  searchmoves: readonly string[] | null;
}

export class LegalFakeEngine implements PoolEngine {
  alive = true;
  constructor(
    readonly idName: string,
    private readonly log: FakeSearch[],
    private readonly crash: (request: SearchRequest) => boolean = () => false
  ) {}

  async newGame(): Promise<void> {}

  async search(request: SearchRequest): Promise<SearchResult> {
    if (!this.alive) {
      throw new EngineCrashedError("dead");
    }
    this.log.push({ moves: request.moves, multipv: request.multipv, searchmoves: request.searchmoves ?? null });
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (this.crash(request)) {
      this.alive = false;
      throw new EngineCrashedError("Engine exited unexpectedly (signal SIGKILL)");
    }
    const line = (uci: string, cp: number): EngineLine => ({
      uci,
      cp,
      mate: null,
      winPct: scoreWinPercent({ cp, mate: null }),
      depth: request.depth ?? 15,
      pv: [uci]
    });
    const lines = request.searchmoves
      ? request.searchmoves.map((uci) => line(uci, -40))
      : replayUci(request.moves)
          .legalUci.slice(0, request.multipv)
          .map((uci, rank) => line(uci, 20 - rank * 10));
    return { lines, depth: request.depth ?? 15, complete: true, nodes: request.searchmoves ? 500 : 1000, bestmove: lines[0]?.uci ?? null, ms: 1 };
  }

  async close(): Promise<void> {
    this.alive = false;
  }

  kill(): void {
    this.alive = false;
  }
}

/** A pool of LegalFakeEngines and the log of every search they ran. */
export function legalFakePool(options: { size?: number; idName?: string; crash?: (request: SearchRequest) => boolean } = {}) {
  const log: FakeSearch[] = [];
  const pool = new EnginePool({
    size: options.size ?? 2,
    spawn: async () => new LegalFakeEngine(options.idName ?? "Stockfish 18", log, options.crash)
  });
  return { pool, log };
}

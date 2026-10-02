// Engine shapes shared by the UCI parser (core/engine/uci.ts), the Stockfish worker client
// (src/engine/) and everything that consumes engine output (judging, explanations, sparring).
// Scores are always from the side to move, as UCI reports them.

/** One principal variation of a search. */
export interface EngineLine {
  /** The first move of the PV. */
  uci: string;
  cp: number | null;
  mate: number | null;
  /** The side to move's win% (lichess curve). */
  winPct: number;
  depth: number;
  /** UCI moves, starting with `uci` (at most PV_MAX_MOVES). */
  pv: string[];
}

/** An engine line with SAN for display. */
export interface AnalysedLine extends EngineLine {
  san: string;
  pvSan: string[];
}

export interface Analysis {
  fen: string;
  depth: number;
  /** MultiPV lines, best first. Empty in a terminal position. */
  lines: AnalysedLine[];
  /** True when every requested line finished the same iteration. */
  complete: boolean;
  terminal: "checkmate" | "stalemate" | null;
}

/** The played move scored against the best move at the same root and depth. */
export interface MoveScore {
  fen: string;
  uci: string;
  best: AnalysedLine;
  played: AnalysedLine;
  /** The mover's win% loss (0 when the played move is as good as the best). */
  loss: number;
  depth: number;
}

export interface AnalyseOptions {
  /** Lines to return (default 1). */
  multiPv?: number;
  /** Search depth limit. */
  depth?: number;
  /** Time limit in ms (used together with depth: whichever comes first). */
  movetimeMs?: number;
  /** Restrict the search to these UCI moves. */
  searchMoves?: string[];
  signal?: AbortSignal;
}

/** What judging, explanations and sparring need from an engine. The browser implementation is src/engine/. */
export interface EngineClient {
  analyse(fen: string, options?: AnalyseOptions): Promise<Analysis>;
  /** Scores `uci` in `fen` against the engine's best move (MultiPV search plus a searchmoves follow-up when needed). */
  scoreMove(fen: string, uci: string, options?: AnalyseOptions): Promise<MoveScore>;
}

/** A plain-language reading of an engine result, for the feedback panel. */
export interface Explanation {
  tone: "good" | "neutral" | "warning" | "bad";
  /** One sentence, e.g. "Sound: the engine rates it about as good as the main move." */
  headline: string;
  /** Short supporting sentences in chess language (material, threats, principles). No raw evaluations. */
  details: string[];
  /** The engine's preferred move in SAN, when it differs from the played one. */
  bestSan?: string;
  /** The opponent's strongest reply to the played move, in SAN. */
  replySan?: string;
}

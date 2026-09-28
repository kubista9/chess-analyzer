import { Chess } from "chess.js";
import { toEpd } from "../../shared/epd.js";
import { rootMoveLoss } from "../../shared/eval.js";
import type { EngineLine, EngineTier, PositionEval } from "../../shared/types.js";
import { ENGINE_PROTOCOL, searchTimeoutMs, tierSpec, type EngineProtocol } from "./protocol.js";
import type { SearchRequest, SearchResult } from "./uci.js";

// One position under the search protocol:
// 1. checkmate / stalemate are resolved with chess.js, without the engine;
// 2. otherwise one MultiPV search at the tier's fixed depth (unless a cached eval is given);
// 3. every played move outside the lines gets a depth-matched searchmoves follow-up on the
//    same root and warm hash, so best and played moves are scored at one root and one depth.

export interface SearchEngine {
  search(request: SearchRequest): Promise<SearchResult>;
}

export interface PositionRequest {
  /** UCI moves from the start position to this position. */
  moves: readonly string[];
  tier: EngineTier;
  /** Moves played from this position that must be scored (e.g. the owner's move here). */
  played?: readonly string[];
  /** A stored eval of this position (same config, tier at least `tier`): only missing moves are searched. */
  cached?: PositionEval | null;
}

export interface ReplayedPosition {
  chess: Chess;
  epd: string;
  legalUci: string[];
}

export function uciOf(move: { from: string; to: string; promotion?: string }): string {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

/** Replays UCI moves from the start; throws on an illegal move. */
export function replayUci(moves: readonly string[]): ReplayedPosition {
  const chess = new Chess();
  for (const [index, uci] of moves.entries()) {
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      throw new Error(`Illegal move ${uci} at ply ${index + 1}`);
    }
  }
  return { chess, epd: toEpd(chess.fen()), legalUci: chess.moves({ verbose: true }).map(uciOf) };
}

export function terminalEval(epd: string, tier: EngineTier, chess: Chess): PositionEval | null {
  const base = { epd, tier, depth: 0, nodes: 0, lines: [], scored: [], bestUci: null };
  if (chess.isCheckmate()) {
    return { ...base, terminal: "checkmate", score: { cp: null, mate: 0 } };
  }
  if (chess.isStalemate()) {
    return { ...base, terminal: "stalemate", score: { cp: 0, mate: null } };
  }
  return null;
}

/** The line for `uci` in an eval: one of the MultiPV lines, or a searchmoves-scored move. */
export function lineFor(evaluation: PositionEval, uci: string): EngineLine | undefined {
  return evaluation.lines.find((line) => line.uci === uci) ?? evaluation.scored.find((line) => line.uci === uci);
}

/** The mover's win% loss for `uci` at this root (vs the rank-1 line), or undefined if it is not scored. */
export function playedLoss(evaluation: PositionEval, uci: string): number | undefined {
  const best = evaluation.lines[0];
  const played = lineFor(evaluation, uci);
  return best && played ? rootMoveLoss(best, played) : undefined;
}

export async function analysePosition(
  engine: SearchEngine,
  request: PositionRequest,
  protocol: EngineProtocol = ENGINE_PROTOCOL
): Promise<PositionEval> {
  const { chess, epd, legalUci } = replayUci(request.moves);
  const terminal = terminalEval(epd, request.tier, chess);
  if (terminal) {
    return terminal;
  }

  const spec = tierSpec(request.tier, protocol);
  const timeoutMs = searchTimeoutMs(protocol);
  let evaluation: PositionEval;

  if (request.cached && request.cached.epd === epd && request.cached.lines.length) {
    // A higher tier's row keeps its tier, so storing it back upgrades that row in place.
    evaluation = { ...request.cached, scored: [...request.cached.scored] };
  } else {
    const main = await engine.search({
      moves: request.moves,
      multipv: spec.multipv,
      expectedRanks: Math.min(spec.multipv, legalUci.length),
      depth: spec.depth,
      nodes: protocol.nodeCap,
      timeoutMs
    });
    if (!main.lines.length) {
      throw new Error(`The engine returned no line for ${epd}`);
    }
    evaluation = {
      epd,
      tier: request.tier,
      depth: main.lines[0].depth,
      nodes: main.nodes,
      lines: main.lines,
      scored: [],
      terminal: null,
      bestUci: main.lines[0].uci,
      score: { cp: main.lines[0].cp, mate: main.lines[0].mate }
    };
  }

  const legal = new Set(legalUci);
  const missing = [...new Set(request.played ?? [])].filter((uci) => legal.has(uci) && !lineFor(evaluation, uci));
  if (missing.length) {
    const follow = await engine.search({
      moves: request.moves,
      multipv: missing.length,
      expectedRanks: missing.length,
      depth: evaluation.depth,
      nodes: protocol.nodeCap,
      searchmoves: missing,
      timeoutMs
    });
    const wanted = new Set(missing);
    const scored = follow.lines.filter((line) => wanted.has(line.uci));
    if (scored.length !== missing.length) {
      const got = new Set(scored.map((line) => line.uci));
      throw new Error(`searchmoves did not score ${missing.filter((uci) => !got.has(uci)).join(", ")} at ${epd}`);
    }
    evaluation.scored.push(...scored);
    evaluation.nodes += follow.nodes;
  }

  return evaluation;
}

import { applyMove, gameState, sideToMove, toEpd, type AppliedMove } from "../chess/position";
import type { RepertoireTree, TreeEdge } from "../content/types";
import type { Analysis, EngineClient } from "../engine/types";
import { mainstreamChildren, nameAt, type BookMove, type OpeningBook } from "../openingDb/book";
import { pickWeighted, type Rng } from "../util/random";
import { SOUND_LOSS } from "./judge";
import { PRIORITY_WEIGHT } from "./queue";
import type { SparringLevel } from "./types";

// The sparring partner: it plays the opponent's side of the user's repertoire, then the opening
// book, then the engine (when it is on). Choices are weighted random picks through the seeded
// generator, so a seed replays the same game.

/** Win% window below the engine's best move that the partner may choose from out of book (win%). */
export const LEVEL_WINDOW: Record<SparringLevel, number> = { relaxed: 12, club: 6, strong: 2.5, best: 0 };

/** Engine lines asked for when the partner needs the engine (MultiPV lines). */
export const SPARRING_MULTI_PV = 4;

/** Without an engine the partner picks among this many most-travelled book moves (moves). */
export const BOOK_TOP_MOVES = 3;

/** The partner's move and where it comes from. */
export interface OpponentChoice {
  uci: string;
  san: string;
  source: "repertoire" | "book" | "engine";
  /** The user's lines that expect this reply (source repertoire). */
  lineIds: string[];
  /** The opening name of the game so far: the deepest named book position up to and including this move. */
  bookName: string | null;
}

/** Everything the partner needs to choose its move in one position. */
export interface SparringContext {
  fen: string;
  /** The moves played so far, from the start. */
  history: readonly AppliedMove[];
  tree: RepertoireTree;
  book: OpeningBook | null;
  rng: Rng;
  engine: EngineClient | null;
  level: SparringLevel;
  movetimeMs: number;
  signal?: AbortSignal;
  /** Default PRIORITY_WEIGHT[edge.priority]. */
  replyWeight?: (edge: TreeEdge) => number;
}

interface Candidate {
  move: AppliedMove;
  weight: number;
  lineIds: string[];
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

function choose(ctx: SparringContext, candidates: readonly Candidate[], source: OpponentChoice["source"]): OpponentChoice | null {
  const index = pickWeighted(
    candidates.map((candidate) => candidate.weight),
    ctx.rng
  );
  if (index < 0) {
    return null;
  }
  const { move, lineIds } = candidates[index];
  const named = ctx.book ? nameAt(ctx.book, [...ctx.history.map((played) => played.epdAfter), move.epdAfter]) : null;
  return { uci: move.uci, san: move.san, source, lineIds, bookName: named?.name ?? null };
}

/** Legal candidates only (a move from a stale tree or book entry is skipped). */
function legal<T>(fen: string, entries: readonly T[], uciOf: (entry: T) => string): { entry: T; move: AppliedMove }[] {
  return entries.flatMap((entry) => {
    const move = applyMove(fen, uciOf(entry));
    return move ? [{ entry, move }] : [];
  });
}

/** The engine-scored book moves within SOUND_LOSS of the best; the top book move is scored on its own if the search missed it. */
async function soundBookMoves(
  ctx: SparringContext,
  engine: EngineClient,
  analysis: Analysis,
  children: readonly { entry: BookMove & { lines: number }; move: AppliedMove }[]
): Promise<Candidate[]> {
  if (analysis.lines.length === 0) {
    return [];
  }
  const best = Math.max(...analysis.lines.map((line) => line.winPct));
  const kept: Candidate[] = [];
  for (const [index, child] of children.entries()) {
    const line = analysis.lines.find((candidate) => candidate.uci === child.move.uci);
    let loss: number | null = line ? Math.max(0, best - line.winPct) : null;
    if (loss === null && index === 0) {
      const score = await engine.scoreMove(ctx.fen, child.move.uci, { movetimeMs: ctx.movetimeMs, signal: ctx.signal });
      loss = Number.isFinite(score.loss) ? Math.max(0, score.loss) : null;
    }
    if (loss !== null && loss < SOUND_LOSS) {
      kept.push({ move: child.move, weight: Math.max(1, child.entry.lines), lineIds: [] });
    }
  }
  return kept.slice(0, BOOK_TOP_MOVES);
}

/** The engine's lines within LEVEL_WINDOW of the best, weighted 1 / (1 + loss). */
function engineCandidates(ctx: SparringContext, analysis: Analysis): Candidate[] {
  if (analysis.lines.length === 0) {
    return [];
  }
  const best = Math.max(...analysis.lines.map((line) => line.winPct));
  const window = LEVEL_WINDOW[ctx.level];
  return legal(ctx.fen, analysis.lines, (line) => line.uci).flatMap(({ entry, move }) => {
    const loss = Math.max(0, best - entry.winPct);
    return loss <= window ? [{ move, weight: 1 / (1 + loss), lineIds: [] }] : [];
  });
}

/**
 * The partner's next move: (1) a repertoire reply at this position, weighted by replyWeight;
 * (2) else a mainstream book move (with an engine: only moves within SOUND_LOSS of its best;
 * without: the top BOOK_TOP_MOVES by line count, weighted by count); (3) else an engine move
 * within LEVEL_WINDOW[level] of the best; (4) else null: out of book and no engine, or the game
 * is over. An engine failure in step 2 falls back to the book choice without the engine; out of
 * book there is no fallback, so an engine failure there rejects with the engine's error, and an
 * abort always rejects (AbortError).
 */
export async function chooseOpponentMove(ctx: SparringContext): Promise<OpponentChoice | null> {
  if (sideToMove(ctx.fen) === ctx.tree.side) {
    throw new Error("chooseOpponentMove: it is the user's move in this position, not the opponent's");
  }
  const state = gameState(ctx.fen);
  if (state === "checkmate" || state === "stalemate") {
    return null;
  }
  const epd = toEpd(ctx.fen);

  const node = ctx.tree.nodes.get(epd);
  const replies = node ? node.edges.filter((edge) => edge.mover === "opponent") : [];
  const weightOf = ctx.replyWeight ?? ((edge: TreeEdge) => PRIORITY_WEIGHT[edge.priority]);
  const repertoire = choose(
    ctx,
    legal(ctx.fen, replies, (edge) => edge.uci).map(({ entry, move }) => ({ move, weight: weightOf(entry), lineIds: [...entry.lineIds] })),
    "repertoire"
  );
  if (repertoire) {
    return repertoire;
  }

  let analysis: Analysis | null = null;
  const children = ctx.book ? legal(ctx.fen, mainstreamChildren(ctx.book, epd), (child) => child.uci) : [];
  if (children.length > 0) {
    let engineFailed = ctx.engine === null;
    if (ctx.engine) {
      try {
        analysis = await ctx.engine.analyse(ctx.fen, { multiPv: SPARRING_MULTI_PV, movetimeMs: ctx.movetimeMs, signal: ctx.signal });
        const sound = choose(ctx, await soundBookMoves(ctx, ctx.engine, analysis, children), "book");
        if (sound) {
          return sound;
        }
      } catch (error) {
        if (isAbortError(error) || ctx.signal?.aborted) {
          throw error;
        }
        engineFailed = true;
      }
    }
    if (engineFailed) {
      return choose(
        ctx,
        children.slice(0, BOOK_TOP_MOVES).map(({ entry, move }) => ({ move, weight: Math.max(1, entry.lines), lineIds: [] })),
        "book"
      );
    }
  }

  if (ctx.engine) {
    analysis ??= await ctx.engine.analyse(ctx.fen, { multiPv: SPARRING_MULTI_PV, movetimeMs: ctx.movetimeMs, signal: ctx.signal });
    return choose(ctx, engineCandidates(ctx, analysis), "engine");
  }
  return null;
}

/** How a sparring game related to the repertoire. */
export interface SparringSummary {
  /** Plies from the start that stayed on the repertoire tree. */
  inRepertoireThrough: number;
  /** Who played the first move off the tree; null if the game never left it. */
  leftBy: "user" | "opponent" | null;
  /** User moves that differ from the repertoire in a repertoire position (also after a transposition back in). */
  userDeviations: { ply: number; played: string; expected: string[] }[];
  userMoves: number;
  /** User moves that were repertoire moves. */
  bookMoves: number;
}

/** What a sparring game says about the repertoire: where it left the tree, by whom, and the user's deviations. */
export function summariseSparring(tree: RepertoireTree, moves: readonly AppliedMove[]): SparringSummary {
  let inRepertoireThrough = 0;
  let leftBy: SparringSummary["leftBy"] = null;
  const userDeviations: SparringSummary["userDeviations"] = [];
  let userMoves = 0;
  let bookMoves = 0;

  for (const [index, move] of moves.entries()) {
    const mover = move.color === tree.side ? "user" : "opponent";
    const edges = tree.nodes.get(move.epdBefore)?.edges.filter((edge) => edge.mover === mover) ?? [];
    const inTree = edges.some((edge) => edge.uci === move.uci);
    if (leftBy === null) {
      if (inTree) {
        inRepertoireThrough = index + 1;
      } else {
        leftBy = mover;
      }
    }
    if (mover === "user") {
      userMoves += 1;
      if (inTree) {
        bookMoves += 1;
      } else if (edges.length > 0) {
        userDeviations.push({ ply: index + 1, played: move.san, expected: edges.map((edge) => edge.san) });
      }
    }
  }

  return { inRepertoireThrough, leftBy, userDeviations, userMoves, bookMoves };
}

import { Chess } from "chess.js";
import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import { classifyLoss, toWhiteEval } from "../../shared/eval.js";
import { analyzeGameOpening, rootVerdict, round2, type EvalLookup } from "../../shared/openingAnalysis.js";
import { nameAt, type OpeningBook } from "../../shared/openingBook.js";
import { treeGameFrom } from "../../shared/openingTree.js";
import { judgeRetry, landingOf, type OpeningReview, type RetryResult, type ReviewBookExit, type ReviewPly } from "../../shared/review.js";
import type { EngineLine, GameRecord, OpeningPly, PlayerColor, PositionEval, ReviewLine } from "../../shared/types.js";
import type { Db } from "../db/connection.js";
import { getGameAnalysis } from "../db/gameAnalysis.js";
import { getGame, getGamePlies } from "../db/games.js";
import { getPositionEval } from "../db/positions.js";
import { lineFor } from "../engine/analysePosition.js";
import { evaluateOpening, isAnswered, openingPositions, recordOpeningFromStore, type OpeningDeps, type OpeningPosition } from "./openingPass.js";

// The opening review (GET /api/games/:id/analysis): the game's first OPENING_PLY_LIMIT plies
// judged from the position cache (shared/openingAnalysis.ts), with every engine line in SAN and
// every eval from White's side. A backfilled game needs no engine at all; for the rest only the
// missing positions go to the pool, at interactive priority, and are stored as they arrive.

/** Thrown for a request the review cannot answer (the route turns it into a 4xx). */
export class ReviewInputError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string
  ) {
    super(message);
  }
}

function moverOf(ply: number): PlayerColor {
  return ply % 2 === 1 ? "white" : "black";
}

/** A full FEN for an EPD before ply `ply` (the clocks do not matter to the review). */
export function fenOf(epd: string, ply: number): string {
  return `${epd} 0 ${Math.ceil(ply / 2)}`;
}

/** An engine line in SAN from White's side; the PV stops at the first move that does not apply. */
export function toReviewLine(fen: string, line: EngineLine, mover: PlayerColor): ReviewLine {
  const chess = new Chess(fen);
  const pvSan: string[] = [];
  for (const uci of line.pv.length ? line.pv : [line.uci]) {
    try {
      pvSan.push(chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san);
    } catch {
      break;
    }
  }
  const white = toWhiteEval(line, mover);
  return { uci: line.uci, san: pvSan[0] ?? line.uci, pvSan, whiteCp: white.cp, mate: white.mate };
}

export interface ReviewInput {
  game: Pick<GameRecord, "id" | "color" | "endTime" | "score" | "myRating" | "oppRating" | "tc" | "plyCount">;
  /** The stored plies of the game (the window and, when stored, a few after it). */
  plies: readonly OpeningPly[];
  lookup: EvalLookup;
  book: OpeningBook;
  configId: number | null;
}

/** The review DTO from a game's plies and the cache. Pure: no engine, no store. */
export function buildOpeningReview(input: ReviewInput): OpeningReview {
  const { game, lookup, book } = input;
  const window = input.plies.slice(0, OPENING_PLY_LIMIT);
  const analysis = analyzeGameOpening(treeGameFrom(game as GameRecord, window), lookup, book, OPENING_PLY_LIMIT);
  const ownerByPly = new Map(analysis.ownerMoves.map((move) => [move.ply, move]));

  const linesAt = (evaluation: PositionEval | undefined, fen: string, mover: PlayerColor) =>
    evaluation ? evaluation.lines.map((line) => toReviewLine(fen, line, mover)) : [];

  const plies: ReviewPly[] = window.map((ply) => {
    const mover = moverOf(ply.ply);
    const owner = mover === game.color;
    const fenBefore = fenOf(ply.epdBefore, ply.ply);
    const evaluation = lookup(ply.epdBefore, owner ? "owner" : "opponent");
    const verdict = rootVerdict(evaluation, ply.uci);
    const ownerMove = ownerByPly.get(ply.ply);
    const loss = owner ? (ownerMove?.status === "scored" ? ownerMove.loss : null) : verdict ? round2(verdict.loss) : null;
    return {
      ply: ply.ply,
      moveNumber: Math.ceil(ply.ply / 2),
      color: mover,
      owner,
      san: ply.san,
      uci: ply.uci,
      fenBefore,
      fenAfter: fenOf(ply.epdAfter, ply.ply + 1),
      inBook: book.positions.has(ply.epdAfter),
      evalAfter: analysis.evalWhite[ply.ply - 1],
      loss,
      cls: loss === null ? null : classifyLoss(loss),
      approx: !owner,
      lines: verdict ? linesAt(evaluation, fenBefore, mover) : [],
      played: verdict ? toReviewLine(fenBefore, verdict.played, mover) : null
    };
  });

  const first = analysis.firstOwnerError;
  const firstOwnerError = first === null || first === "pending" ? first : first.ply;
  const exit = analysis.bookExit;
  const named = exit ? nameAt(book, window.slice(0, exit.lastBookPly).map((ply) => ply.epdAfter)) : null;
  const bookExit: ReviewBookExit | null = exit ? { ...exit, name: named?.name ?? null, eco: named?.eco ?? null } : null;
  const startEpd = window[0]?.epdBefore;
  const startFen = startEpd ? fenOf(startEpd, 1) : new Chess().fen();

  return {
    gameId: game.id,
    color: game.color,
    configId: input.configId,
    status: analysis.status,
    coverage: { plies: analysis.coverage.plies, pliesScored: analysis.coverage.pliesScored },
    start: { fen: startFen, lines: startEpd ? linesAt(lookup(startEpd, game.color === "white" ? "owner" : "opponent"), startFen, "white") : [] },
    plies,
    firstOwnerError,
    landing: landingOf(plies.length, firstOwnerError, bookExit),
    bookExit,
    later: input.plies.slice(OPENING_PLY_LIMIT).map((ply) => ({ ply: ply.ply, san: ply.san })),
    totalPlies: game.plyCount
  };
}

interface StoredGame {
  game: GameRecord;
  plies: OpeningPly[];
  positions: OpeningPosition[];
}

function loadGame(db: Db, gameId: string): StoredGame {
  const game = getGame(db, gameId);
  if (!game) {
    throw new ReviewInputError(404, `Game ${gameId} is not in the game store. Sync from Home first.`);
  }
  const plies = getGamePlies(db, gameId);
  if (!plies.length) {
    throw new ReviewInputError(404, `Game ${gameId} has no moves to review.`);
  }
  return { game, plies, positions: openingPositions(plies.slice(0, OPENING_PLY_LIMIT), game.color) };
}

/** The cache of one engine config, read straight from the store (at most ~20 lookups a review). */
function storeLookup(db: Db, configId: number | null): EvalLookup {
  return (epd, tier) => (configId === null ? undefined : getPositionEval(db, configId, epd, tier));
}

/**
 * The review of a stored game from the cache alone (null config = no engine: everything
 * pending). A complete review of a game without a game_analysis row also writes that row, so
 * the backfill skips the game.
 */
export function reviewFromStore(db: Db, gameId: string, configId: number | null, book: OpeningBook): OpeningReview {
  const stored = loadGame(db, gameId);
  const review = buildOpeningReview({ game: stored.game, plies: stored.plies, lookup: storeLookup(db, configId), book, configId });
  if (configId !== null && review.status === "complete" && !getGameAnalysis(db, gameId, configId)) {
    recordOpeningFromStore(db, configId, gameId, stored.positions, stored.game.color);
  }
  return review;
}

/**
 * Fills in a game's missing positions (only those: the cache answers the rest) on the pool at
 * interactive priority, then returns the complete review.
 */
export async function completeReview(
  deps: OpeningDeps,
  gameId: string,
  book: OpeningBook,
  onProgress?: (done: number, total: number) => void
): Promise<OpeningReview> {
  const stored = loadGame(deps.db, gameId);
  await evaluateOpening(
    deps,
    `review:${gameId}`,
    stored.positions.map((position) => ({ position, played: [position.played] })),
    { priority: "interactive", onProgress }
  );
  return reviewFromStore(deps.db, gameId, deps.configId, book);
}

/**
 * Judges a Retry move: the owner's `uci` from the position before ply `ply`, against the best
 * line at that root. A move the cache has not scored is scored now (a depth-matched searchmoves
 * follow-up at interactive priority) and stored.
 */
export async function retryMove(deps: OpeningDeps, gameId: string, ply: number, uci: string): Promise<RetryResult> {
  const stored = loadGame(deps.db, gameId);
  const position = stored.positions[ply - 1];
  if (!position) {
    throw new ReviewInputError(400, `Ply ${ply} is outside the reviewed opening (1-${stored.positions.length}).`);
  }
  if (position.tier !== "owner") {
    throw new ReviewInputError(400, `Ply ${ply} is your opponent's move; Retry is for your own moves.`);
  }
  const fen = fenOf(position.epd, ply);
  let san: string;
  try {
    san = new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch {
    throw new ReviewInputError(400, `${uci} is not a legal move in this position.`);
  }

  const cached = getPositionEval(deps.db, deps.configId, position.epd, "owner");
  const searched = !isAnswered(cached, [uci]);
  const evaluation = searched
    ? (await evaluateOpening(deps, `retry:${gameId}:${ply}`, [{ position: { ...position, played: uci, san }, played: [uci] }], { priority: "interactive" }))[0]
    : cached!;
  const best = evaluation.lines[0];
  const played = lineFor(evaluation, uci);
  if (!best || !played) {
    throw new Error(`The engine did not score ${san} at ply ${ply}`);
  }
  const { loss, verdict } = judgeRetry(best, played);
  return {
    ply,
    uci,
    san,
    loss,
    verdict,
    best: toReviewLine(fen, best, position.mover),
    played: toReviewLine(fen, played, position.mover),
    searched
  };
}

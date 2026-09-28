import { Chess } from "chess.js";
import { bookExit, type BookExit, type OpeningBook } from "./openingBook.js";
import type { TreeGame } from "./openingTree.js";
import { classifyLoss, isOpeningError, rootMoveLoss, scoreWinPercent, toWhiteEval, whiteWinPercent } from "./eval.js";
import type { EngineLine, EngineTier, MoveCategory, OwnerViewEval, PlayerColor, PositionEval } from "./types.js";

// A game's opening as the engine sees it, derived from the position cache and the game's plies
// alone: nothing here is persisted, so it follows the cache as the backfill fills it. A position
// the cache cannot answer (no row, or the played move not scored) is "pending", never a number.
//
// Every threshold is an exported constant so the verify scripts can tune the headline numbers.

/** An opponent move losing at least this much (win%, at a MultiPV 1 root) is an opponent error. */
export const OPPONENT_ERROR_LOSS = 10;
/** After an opponent error, an owner reply losing this much while the best keeps >= MISSED_PUNISH_WIN_BEST is a missed punishment. */
export const MISSED_PUNISH_LOSS = 5;
export const MISSED_PUNISH_WIN_BEST = 60;
/** Plies at which the owner's eval is recorded (ply 20 = after move 10). */
export const EVAL_AT_PLIES = [10, 16, 20] as const;
/** Think time is summed over this many of the owner's first moves. */
export const SPENT_OWN_MOVES = 10;

/** The cache: the best stored eval of a position at a tier or above, or undefined. */
export type EvalLookup = (epd: string, tier: EngineTier) => PositionEval | undefined;

/** An eval from White's side: cp clamped to +/-1000, mate > 0 when White mates. */
export interface WhiteEvalPoint {
  cp: number;
  mate: number | null;
  whiteWinPct: number;
}

export type Pending = "pending";

interface MoveBase {
  ply: number;
  san: string;
  uci: string;
  epdBefore: string;
  /** The position the move reaches is a book position. */
  inBook: boolean;
}

export interface OwnerMoveScored extends MoveBase {
  status: "scored";
  bestUci: string;
  bestSan: string;
  /** The owner's win% with the best move and with the played one, at the move's root. */
  winBest: number;
  winPlayed: number;
  loss: number;
  cls: MoveCategory;
}

export interface OwnerMovePending extends MoveBase {
  status: "pending";
}

export type OwnerMoveAnalysis = OwnerMoveScored | OwnerMovePending;

export interface OpponentError {
  ply: number;
  san: string;
  uci: string;
  /** From the opponent-tier search (MultiPV 1, a shallower depth): approximate. */
  approxLoss: number;
  approx: true;
}

export interface MissedPunish {
  /** The owner's reply. */
  ply: number;
  san: string;
  uci: string;
  loss: number;
  winBest: number;
  bestSan: string;
  /** The ply of the opponent error it failed to punish. */
  errorPly: number;
}

export interface GameOpeningAnalysis {
  gameId: string;
  color: PlayerColor;
  /** Plies analysed: the game's opening plies (at most the tree's window). */
  plies: number;
  coverage: { ownerMoves: number; scored: number; plies: number; pliesScored: number };
  /** complete: every ply of the window is scored. */
  status: "complete" | "partial";
  /** [i] = the eval after ply i + 1 (the played move's score at its root), from White's side. */
  evalWhite: (WhiteEvalPoint | Pending)[];
  ownerMoves: OwnerMoveAnalysis[];
  /** The first owner move classed mistake or worse; null = a clean opening; pending = unknown yet. */
  firstOwnerError: OwnerMoveScored | null | Pending;
  firstInaccuracyPly: number | null | Pending;
  opponentErrors: OpponentError[];
  missedPunish: MissedPunish[];
  /** The owner's eval after plies 10, 16 and 20 (those the game reaches). */
  evalAt: { ply: number; eval: OwnerViewEval | Pending }[];
  bookExit: BookExit | null;
  /** Seconds the owner spent on his first SPENT_OWN_MOVES moves; null without clock data. */
  spentSec: number | null;
}

const sanMemo = new Map<string, string>();

/** The SAN of a UCI move in a position (EPD), memoised; the UCI itself if it does not apply. */
export function sanOf(epd: string, uci: string): string {
  const key = `${epd}|${uci}`;
  let san = sanMemo.get(key);
  if (san === undefined) {
    try {
      san = new Chess(`${epd} 0 1`).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
    } catch {
      san = uci;
    }
    if (sanMemo.size > 50_000) {
      sanMemo.clear();
    }
    sanMemo.set(key, san);
  }
  return san;
}

function lineOf(evaluation: PositionEval, uci: string): EngineLine | undefined {
  return evaluation.lines.find((line) => line.uci === uci) ?? evaluation.scored.find((line) => line.uci === uci);
}

/** A side-to-move score as a White-view point. */
export function whitePoint(score: { cp: number | null; mate: number | null }, mover: PlayerColor): WhiteEvalPoint {
  const white = toWhiteEval(score, mover);
  return { cp: white.cp, mate: white.mate, whiteWinPct: round2(whiteWinPercent(white)) };
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The judged move at one root, or null when the cache cannot answer it. */
export interface RootVerdict {
  best: EngineLine;
  played: EngineLine;
  loss: number;
}

export function rootVerdict(evaluation: PositionEval | undefined, uci: string): RootVerdict | null {
  const best = evaluation?.lines[0];
  const played = evaluation && lineOf(evaluation, uci);
  return best && played ? { best, played, loss: rootMoveLoss(best, played) } : null;
}

function moverOf(ply: number): PlayerColor {
  return ply % 2 === 1 ? "white" : "black";
}

/** A game's opening from the cache. `maxPly` caps the plies (the tree's window). */
export function analyzeGameOpening(game: TreeGame, lookup: EvalLookup, book?: OpeningBook, maxPly?: number): GameOpeningAnalysis {
  const plies = game.plies.slice(0, maxPly ?? game.plies.length);
  const evalWhite: (WhiteEvalPoint | Pending)[] = [];
  const ownerMoves: OwnerMoveAnalysis[] = [];
  const opponentErrors: OpponentError[] = [];
  const missedPunish: MissedPunish[] = [];
  let pliesScored = 0;
  let lastOpponentError: OpponentError | null = null;
  let spentMs = 0;
  let spentN = 0;
  let ownSeen = 0;

  for (const [index, ply] of plies.entries()) {
    const number = index + 1;
    const mover = moverOf(number);
    const owner = mover === game.color;
    const verdict = rootVerdict(lookup(ply.epdBefore, owner ? "owner" : "opponent"), ply.uci);
    evalWhite.push(verdict ? whitePoint(verdict.played, mover) : "pending");
    if (verdict) {
      pliesScored += 1;
    }
    const inBook = book?.positions.has(ply.epdAfter) ?? false;
    const base: MoveBase = { ply: number, san: ply.san, uci: ply.uci, epdBefore: ply.epdBefore, inBook };

    if (!owner) {
      lastOpponentError = null;
      if (verdict && verdict.loss >= OPPONENT_ERROR_LOSS) {
        lastOpponentError = { ply: number, san: ply.san, uci: ply.uci, approxLoss: round2(verdict.loss), approx: true };
        opponentErrors.push(lastOpponentError);
      }
      continue;
    }

    ownSeen += 1;
    if (ownSeen <= SPENT_OWN_MOVES && ply.spentMs !== null) {
      spentMs += ply.spentMs;
      spentN += 1;
    }
    if (!verdict) {
      ownerMoves.push({ ...base, status: "pending" });
      lastOpponentError = null;
      continue;
    }
    const scored: OwnerMoveScored = {
      ...base,
      status: "scored",
      bestUci: verdict.best.uci,
      bestSan: sanOf(ply.epdBefore, verdict.best.uci),
      winBest: round2(scoreWinPercent(verdict.best)),
      winPlayed: round2(scoreWinPercent(verdict.played)),
      loss: round2(verdict.loss),
      cls: classifyLoss(verdict.loss)
    };
    ownerMoves.push(scored);
    if (lastOpponentError && verdict.loss >= MISSED_PUNISH_LOSS && scored.winBest >= MISSED_PUNISH_WIN_BEST) {
      missedPunish.push({
        ply: number,
        san: ply.san,
        uci: ply.uci,
        loss: scored.loss,
        winBest: scored.winBest,
        bestSan: scored.bestSan,
        errorPly: lastOpponentError.ply
      });
    }
    lastOpponentError = null;
  }

  const evalAt = EVAL_AT_PLIES.filter((ply) => ply <= plies.length).map((ply) => {
    const point = evalWhite[ply - 1];
    return { ply, eval: point === "pending" ? ("pending" as const) : ownerView(point, ply, game.color) };
  });
  const scoredOwner = ownerMoves.filter((move) => move.status === "scored").length;

  return {
    gameId: game.id,
    color: game.color,
    plies: plies.length,
    coverage: { ownerMoves: ownerMoves.length, scored: scoredOwner, plies: plies.length, pliesScored },
    status: pliesScored === plies.length ? "complete" : "partial",
    evalWhite,
    ownerMoves,
    firstOwnerError: firstWhere(ownerMoves, (move) => isOpeningError(move.cls)),
    firstInaccuracyPly: plyOf(firstWhere(ownerMoves, (move) => move.cls !== "best" && move.cls !== "good")),
    opponentErrors,
    missedPunish,
    evalAt,
    bookExit: book ? bookExit(book, plies.map((ply) => ply.epdAfter), game.color) : null,
    spentSec: spentN ? round2(spentMs / 1000) : null
  };
}

function ownerView(point: WhiteEvalPoint, ply: number, color: PlayerColor): OwnerViewEval {
  const sign = color === "white" ? 1 : -1;
  return {
    ply,
    cp: sign * point.cp,
    mate: point.mate === null ? null : sign * point.mate,
    winPct: round2(color === "white" ? point.whiteWinPct : 100 - point.whiteWinPct)
  };
}

/** The first scored move matching `test`, walking in order: pending if an unscored move comes first. */
function firstWhere(moves: readonly OwnerMoveAnalysis[], test: (move: OwnerMoveScored) => boolean): OwnerMoveScored | null | Pending {
  for (const move of moves) {
    if (move.status === "pending") {
      return "pending";
    }
    if (test(move)) {
      return move;
    }
  }
  return null;
}

function plyOf(move: OwnerMoveScored | null | Pending): number | null | Pending {
  return move === null || move === "pending" ? move : move.ply;
}

/**
 * Whether the game's first owner error is known up to (and including) `ply`: every owner move
 * up to it is scored. Requiring the whole span (not just "an error was found") keeps the rates
 * from favouring games with an early error.
 */
export function errorKnownThrough(analysis: GameOpeningAnalysis, ply: number): boolean {
  return analysis.ownerMoves.every((move) => move.ply > ply || move.status === "scored");
}

/** The first owner error's ply, if the game has one (known or not). */
export function firstErrorPly(analysis: GameOpeningAnalysis): number | null {
  const first = analysis.firstOwnerError;
  return first === null || first === "pending" ? null : first.ply;
}

/** Shares of games with a first owner error by each ply, over the games where that is known. */
export function firstErrorShares(
  analyses: readonly GameOpeningAnalysis[],
  plies: readonly number[]
): { ply: number; games: number; known: number; errors: number; rate: number | null }[] {
  return plies.map((ply) => {
    let known = 0;
    let errors = 0;
    for (const analysis of analyses) {
      const reach = Math.min(ply, analysis.plies);
      if (!errorKnownThrough(analysis, reach)) {
        continue;
      }
      known += 1;
      const at = firstErrorPly(analysis);
      if (at !== null && at <= ply) {
        errors += 1;
      }
    }
    return { ply, games: analyses.length, known, errors, rate: known ? errors / known : null };
  });
}

/** A frequent first mistake: the move, how often it was the first error, and the engine's move there. */
export interface FirstMistake {
  epd: string;
  ply: number;
  san: string;
  uci: string;
  bestSan: string;
  bestUci: string;
  count: number;
  /** Mean win% loss. */
  loss: number;
}

/** The most common first mistakes among `errors` (the games' first errors), most frequent first. */
export function topFirstMistakes(errors: readonly OwnerMoveScored[], limit = 3): FirstMistake[] {
  const groups = new Map<string, FirstMistake & { lossSum: number }>();
  for (const move of errors) {
    const key = `${move.epdBefore}|${move.uci}`;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      group.lossSum += move.loss;
      group.ply = Math.min(group.ply, move.ply);
    } else {
      groups.set(key, {
        epd: move.epdBefore,
        ply: move.ply,
        san: move.san,
        uci: move.uci,
        bestSan: move.bestSan,
        bestUci: move.bestUci,
        count: 1,
        loss: 0,
        lossSum: move.loss
      });
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || b.lossSum - a.lossSum || a.ply - b.ply)
    .slice(0, limit)
    .map(({ lossSum, ...group }) => ({ ...group, loss: round2(lossSum / group.count) }));
}

/** Engine claims about a set of games are shown only with at least this many games known... */
export const ENGINE_MIN_GAMES = 5;
/** ...and at least this share of the games known. */
export const ENGINE_MIN_COVERAGE = 0.5;

export function coverageOk(known: number, total: number): boolean {
  return known >= ENGINE_MIN_GAMES && total > 0 && known / total >= ENGINE_MIN_COVERAGE;
}

/** The owner's mean eval after `ply` over the games where it is known. */
export function meanEvalAt(analyses: readonly GameOpeningAnalysis[], ply: number): { known: number; cp: number; winPct: number } | null {
  let known = 0;
  let cp = 0;
  let win = 0;
  for (const analysis of analyses) {
    const at = analysis.evalAt.find((entry) => entry.ply === ply);
    if (at && at.eval !== "pending") {
      known += 1;
      cp += at.eval.cp;
      win += at.eval.winPct;
    }
  }
  return known ? { known, cp: Math.round(cp / known), winPct: round2(win / known) } : null;
}

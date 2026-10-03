import { Chess, type PieceSymbol, type Square } from "chess.js";
import { describeMove, pieceName } from "../chess/features";
import { formatLine, moveLabel } from "../chess/format";
import { PIECE_VALUES, materialState } from "../chess/material";
import { principleNotes } from "../chess/principles";
import {
  START_EPD,
  applyMove,
  checkedKingSquare,
  colorCode,
  fenOf,
  isValidFen,
  legalMoves,
  opposite,
  toEpd,
  type AppliedMove,
  type Color
} from "../chess/position";
import { CATEGORY_THRESHOLDS } from "./score";
import type { AnalysedLine, Explanation, MoveScore } from "./types";

// A scored move in plain chess language, for the feedback panel: what happens along the engine's
// line after the move (material, mate), which opening principle it bends, and what the engine's
// preferred move does instead. Raw evaluations (centipawns, win%) never appear in the text; the
// position is only ever described in words ("you are slightly worse").
//
// Material is read from the board along the engine's line, at the first settled position (no
// check, capture or promotion pending) where it has changed, so a line is never cut between a
// capture and its recapture. A change that starts late in the line, or that the rest of the line
// undoes, is left out: it is not this move's doing.

/** Win% bands of describeBalance for the user's side: >= clearlyBetter, >= slightlyBetter, > slightlyWorse (equal), > clearlyWorse (win%). */
export const BALANCE_BANDS = { clearlyBetter: 70, slightlyBetter: 58, slightlyWorse: 42, clearlyWorse: 30 } as const;

/** Below this mover's win% loss a move is explained as sound; the same value as SOUND_LOSS in core/training/judge.ts (win%). */
export const EXPLAIN_SOUND_LOSS = CATEGORY_THRESHOLDS.good;

/** From this mover's win% loss on a move is explained as a real mistake; the same value as MISTAKE_LOSS in judge.ts (win%). */
export const EXPLAIN_MISTAKE_LOSS = CATEGORY_THRESHOLDS.inaccuracy;

/** Plies of the engine's line searched for a mate, the move itself included (plies). */
export const REPLY_PLIES = 6;

/** A material change counts as the move's doing only when its first capture comes within this many plies, the move itself included (plies). */
export const MATERIAL_WINDOW_PLIES = 4;

/** Material changes smaller than this are not mentioned (pawns). */
export const MATERIAL_MIN_PAWNS = 1;

/** At most this many detail sentences (count). */
export const MAX_DETAILS = 3;

/** The headline by the mover's win% loss: below EXPLAIN_SOUND_LOSS, below EXPLAIN_MISTAKE_LOSS, and from there on. */
export const EXPLANATION_HEADLINES = {
  sound: "Sound: the engine rates it close to its first choice.",
  inaccurate: "Playable but less accurate: it gives away part of your position.",
  mistake: "A real mistake: it gives away a large part of your position."
} as const;

/** Sharper mistake headlines when the result itself is bad, not only worse than the engine's choice. */
export const MISTAKE_HEADLINES = {
  mated: "A real mistake: it allows a forced mate.",
  clearlyWorse: "A real mistake: it gives the opponent a clear edge."
} as const;

function headlineFor(grade: Grade, score: MoveScore): string {
  if (grade !== "mistake") {
    return EXPLANATION_HEADLINES[grade];
  }
  if (score.played.mate !== null && score.played.mate <= 0) {
    return MISTAKE_HEADLINES.mated;
  }
  return score.played.winPct <= BALANCE_BANDS.clearlyWorse ? MISTAKE_HEADLINES.clearlyWorse : EXPLANATION_HEADLINES.mistake;
}

type Grade = keyof typeof EXPLANATION_HEADLINES;

const TONES: Record<Grade, Explanation["tone"]> = { sound: "good", inaccurate: "warning", mistake: "bad" };

/** The user's standing in words, from the user's win% (lower case, to sit inside a sentence). */
export function describeBalance(winPctForUser: number): string {
  if (!Number.isFinite(winPctForUser)) {
    throw new Error(`Invalid win%: ${winPctForUser}`);
  }
  if (winPctForUser >= BALANCE_BANDS.clearlyBetter) {
    return "you are clearly better";
  }
  if (winPctForUser >= BALANCE_BANDS.slightlyBetter) {
    return "you are slightly better";
  }
  if (winPctForUser > BALANCE_BANDS.slightlyWorse) {
    return "the position is roughly equal";
  }
  if (winPctForUser > BALANCE_BANDS.clearlyWorse) {
    return "you are slightly worse";
  }
  return "you are clearly worse";
}

export interface ExplainInput {
  /** The engine's verdict on `move` (score.played is the move, score.best the engine's choice). */
  score: MoveScore;
  /** The move the user played. */
  move: AppliedMove;
  /** The moves before it, from the start of the game (for move numbers and opening principles). */
  history: readonly AppliedMove[];
  /**
   * False leaves out the sentence that names the engine's preferred move, which may be the
   * repertoire move the user is still looking for. bestSan is set either way. Default true.
   */
  showBest?: boolean;
}

/**
 * Explains a scored move: a headline by the loss (EXPLANATION_HEADLINES), then up to MAX_DETAILS
 * sentences: what the engine's line does to you (mate, material, or the resulting balance), the
 * opening principles the move bends (only for a move that is not sound), and what the engine's
 * preferred move does. Throws when the score belongs to a different move or position.
 */
export function explainMoveScore(input: ExplainInput): Explanation {
  const { score, move, history } = input;
  // Compare positions as chess.js writes them (it drops an en-passant square no capture can use).
  const scoredEpd = applyMove(score.fen, score.uci)?.epdBefore ?? toEpd(score.fen);
  if (score.uci !== move.uci || score.played.uci !== move.uci || scoredEpd !== move.epdBefore) {
    throw new Error(`The score is for ${score.played.uci} in "${score.fen}", not for ${move.uci} in "${move.fenBefore}"`);
  }
  if (!Number.isFinite(score.loss) || score.loss < 0) {
    throw new Error(`Invalid win% loss: ${score.loss}`);
  }
  const grade: Grade = score.loss < EXPLAIN_SOUND_LOSS ? "sound" : score.loss < EXPLAIN_MISTAKE_LOSS ? "inaccurate" : "mistake";
  const context: Context = {
    score,
    move,
    history,
    grade,
    user: move.color,
    ply: plyOf(move, history),
    played: playedLine(move, score.played),
    best: replayLine(move.fenBefore, score.best.pv),
    pending: pendingCapture(move, history)
  };
  const isBest = score.best.uci === move.uci;

  const details: string[] = [];
  const consequence = playedConsequence(context);
  if (consequence) {
    details.push(consequence);
  }
  if (grade !== "sound") {
    details.push(...principleNotes(move, history).map((note) => note.text));
  }
  const closing = isBest ? "It is the engine's first choice." : input.showBest === false ? null : preferenceSentence(context);
  const kept = details.slice(0, MAX_DETAILS - (closing ? 1 : 0));
  if (closing) {
    kept.push(closing);
  }

  const explanation: Explanation = { tone: TONES[grade], headline: headlineFor(grade, score), details: kept };
  if (!isBest) {
    explanation.bestSan = score.best.san;
  }
  const reply = score.played.pvSan[1];
  if (reply !== undefined) {
    explanation.replySan = reply;
  }
  return explanation;
}

interface Context {
  score: MoveScore;
  move: AppliedMove;
  history: readonly AppliedMove[];
  grade: Grade;
  user: Color;
  /** 1-based ply of the user's move. */
  ply: number;
  /** The played line replayed from the position before the move (starts with the move). */
  played: AppliedMove[];
  /** The engine's best line, replayed the same way (empty if it does not replay). */
  best: AppliedMove[];
  /** The opponent's capture just before the move, which the move may have to answer. */
  pending: AppliedMove | null;
}

/** The ply of `move`: from the history when it runs from the start position, else from the FEN's move number. */
function plyOf(move: AppliedMove, history: readonly AppliedMove[]): number {
  const fromStart =
    history.length === 0 ? move.epdBefore === START_EPD : history[0].epdBefore === START_EPD && history[history.length - 1].epdAfter === move.epdBefore;
  if (fromStart) {
    return history.length + 1;
  }
  const fullmove = Number(move.fenBefore.split(" ")[5]);
  const number = Number.isInteger(fullmove) && fullmove > 0 ? fullmove : 1;
  return (number - 1) * 2 + (move.color === "white" ? 1 : 2);
}

/** Plays the UCI moves of a line from `fen` and stops at the first one that is not legal. */
function replayLine(fen: string, pv: readonly string[]): AppliedMove[] {
  const moves: AppliedMove[] = [];
  let current = fen;
  for (const uci of pv) {
    const move = applyMove(current, uci);
    if (!move) {
      break;
    }
    moves.push(move);
    current = move.fenAfter;
  }
  return moves;
}

function playedLine(move: AppliedMove, played: AnalysedLine): AppliedMove[] {
  const line = replayLine(move.fenBefore, played.pv);
  return line.length > 0 ? line : [move];
}

function pendingCapture(move: AppliedMove, history: readonly AppliedMove[]): AppliedMove | null {
  const previous = history[history.length - 1];
  return previous && previous.color !== move.color && previous.captured !== null && previous.epdAfter === move.epdBefore ? previous : null;
}

/** The moves that give checkmate at once, sorted by UCI. */
function matingMoves(fen: string): AppliedMove[] {
  return legalMoves(fen)
    .filter((move) => move.checkmate)
    .sort((left, right) => (left.uci < right.uci ? -1 : left.uci > right.uci ? 1 : 0));
}

/** The position with the other side to move, as if the side to move passed (null when it is in check). */
function passTurn(fen: string): string | null {
  if (checkedKingSquare(fen) !== null) {
    return null;
  }
  const fields = fenOf(fen).split(" ");
  fields[1] = fields[1] === "w" ? "b" : "w";
  fields[3] = "-";
  const passed = fields.join(" ");
  return isValidFen(passed) ? passed : null;
}

function sansOf(moves: readonly AppliedMove[]): string[] {
  return moves.map((move) => move.san);
}

// ---------------------------------------------------------------------------------------------
// Material along a line

interface MaterialSwing {
  /** The user's pieces taken along the counted plies, net of equal trades, most valuable first. */
  lost: PieceSymbol[];
  /** The opponent's pieces taken, likewise. */
  won: PieceSymbol[];
  /** The change in the user's material from the board, in pawns. */
  net: number;
  /** Index of the last capture or promotion counted (-1 when there is none). */
  lastCapture: number;
  /** False when a promotion is involved, so the piece lists do not add up to `net`. */
  exact: boolean;
}

const VALUE_ORDER: PieceSymbol[] = ["q", "r", "b", "n", "p"];

function byValue(left: PieceSymbol, right: PieceSymbol): number {
  return VALUE_ORDER.indexOf(left) - VALUE_ORDER.indexOf(right);
}

/** Removes equal trades: the same piece first, then a piece of the same value (bishop for knight). */
function cancelTrades(lost: PieceSymbol[], won: PieceSymbol[]): void {
  for (const sameValue of [false, true]) {
    for (let index = won.length - 1; index >= 0; index -= 1) {
      const match = lost.findIndex((piece) => (sameValue ? PIECE_VALUES[piece] === PIECE_VALUES[won[index]] : piece === won[index]));
      if (match !== -1) {
        lost.splice(match, 1);
        won.splice(index, 1);
      }
    }
  }
  lost.sort(byValue);
  won.sort(byValue);
}

/**
 * True when the position after ply `index` is settled: that ply is not a check and the next ply is
 * not a capture, promotion or check. The last ply of a line is settled only when it is itself quiet
 * and leaves nothing hanging: an engine line often stops in the middle of an exchange.
 */
function isQuiet(line: readonly AppliedMove[], index: number): boolean {
  const move = line[index];
  const next = line[index + 1];
  if (move.check) {
    return false;
  }
  if (next === undefined) {
    return move.captured === null && move.promotion === null && !hasCheapCapture(move.fenAfter);
  }
  return next.captured === null && next.promotion === null && !next.check;
}

/**
 * True when the side to move can take a knight or more that is undefended or worth more than the
 * capturer: the material at the end of a line is not final then (a pending recapture).
 */
function hasCheapCapture(fen: string): boolean {
  let chess: Chess;
  try {
    chess = new Chess(fenOf(fen));
  } catch {
    return false;
  }
  const enemy = chess.turn() === "w" ? "b" : "w";
  return chess.moves({ verbose: true }).some((candidate) => {
    if (!candidate.captured || PIECE_VALUES[candidate.captured] < PIECE_VALUES.n) {
      return false;
    }
    return PIECE_VALUES[candidate.captured] > PIECE_VALUES[candidate.piece] || !chess.isAttacked(candidate.to as Square, enemy);
  });
}

/**
 * The material the user wins or loses because of the move at the start of `line`: the change at the
 * first settled position after the opponent's reply where it reaches MATERIAL_MIN_PAWNS. Null when
 * there is none, when the change starts later than MATERIAL_WINDOW_PLIES (a later exchange is not
 * this move's doing), or when the rest of the line gives it back.
 */
function materialSwing(line: readonly AppliedMove[], user: Color): MaterialSwing | null {
  if (line.length < 2) {
    return null;
  }
  const sign = user === "white" ? 1 : -1;
  const baseline = materialState(line[0].fenBefore).balance;
  const netAt = (index: number) => sign * (materialState(line[index].fenAfter).balance - baseline);

  let point = -1;
  for (let index = 1; index < line.length; index += 1) {
    if (isQuiet(line, index) && Math.abs(netAt(index)) >= MATERIAL_MIN_PAWNS) {
      point = index;
      break;
    }
  }
  if (point === -1) {
    return null;
  }
  // The change starts with the first capture after the material was last level.
  let level = -1;
  for (let index = 0; index < point; index += 1) {
    if (Math.abs(netAt(index)) < MATERIAL_MIN_PAWNS) {
      level = index;
    }
  }
  const start = line.findIndex((move, index) => index > level && (move.captured !== null || move.promotion !== null));
  if (start === -1 || start >= MATERIAL_WINDOW_PLIES) {
    return null;
  }
  const net = netAt(point);
  // Every later settled position, and the line's last position even mid-exchange, must keep the
  // change (same side, still worth a mention): material the line wins back was never really won or lost.
  for (let index = point + 1; index < line.length; index += 1) {
    if (index !== line.length - 1 && !isQuiet(line, index)) {
      continue;
    }
    const kept = netAt(index);
    if (Math.sign(kept) !== Math.sign(net) || Math.abs(kept) < MATERIAL_MIN_PAWNS) {
      return null;
    }
  }

  const lost: PieceSymbol[] = [];
  const won: PieceSymbol[] = [];
  let lastCapture = -1;
  let exact = true;
  line.slice(0, point + 1).forEach((move, index) => {
    if (move.captured !== null) {
      (move.color === user ? won : lost).push(move.captured);
      lastCapture = index;
    }
    if (move.promotion !== null) {
      exact = false;
      lastCapture = index;
    }
  });
  cancelTrades(lost, won);
  return { lost, won, net, lastCapture, exact };
}

const PIECE_PLURALS: Record<PieceSymbol, string> = { p: "pawns", n: "knights", b: "bishops", r: "rooks", q: "queens", k: "kings" };
const COUNT_WORDS = ["no", "a", "two", "three", "four", "five", "six", "seven", "eight"];

/** "a pawn", "two pawns", "a knight and a pawn", "your queen" (own) / "the queen" (the opponent's). */
function pieceList(pieces: readonly PieceSymbol[], owner: "own" | "theirs"): string {
  const parts: string[] = [];
  for (const piece of VALUE_ORDER) {
    const count = pieces.filter((candidate) => candidate === piece).length;
    if (count === 1) {
      parts.push(piece === "q" ? (owner === "own" ? "your queen" : "the queen") : `a ${pieceName(piece)}`);
    } else if (count > 1) {
      parts.push(`${COUNT_WORDS[count] ?? String(count)} ${PIECE_PLURALS[piece]}`);
    }
  }
  return parts.length <= 1 ? (parts[0] ?? "material") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** A rook given for a single minor piece. */
function isExchange(rookSide: readonly PieceSymbol[], minorSide: readonly PieceSymbol[]): boolean {
  return rookSide.length === 1 && rookSide[0] === "r" && minorSide.length === 1 && (minorSide[0] === "n" || minorSide[0] === "b");
}

/** What the user gives up in a losing swing: "a pawn", "the exchange", "a knight for a pawn". */
function lossObject(swing: MaterialSwing): string {
  if (!swing.exact) {
    return "material";
  }
  if (isExchange(swing.lost, swing.won)) {
    return "the exchange";
  }
  return swing.won.length === 0 ? pieceList(swing.lost, "own") : `${pieceList(swing.lost, "own")} for ${pieceList(swing.won, "theirs")}`;
}

/** What the user wins in a winning swing: "a pawn", "the exchange", "a rook for a knight". */
function gainObject(swing: MaterialSwing): string {
  if (!swing.exact) {
    return "material";
  }
  if (isExchange(swing.won, swing.lost)) {
    return "the exchange";
  }
  return swing.lost.length === 0 ? pieceList(swing.won, "theirs") : `${pieceList(swing.won, "theirs")} for ${pieceList(swing.lost, "own")}`;
}

/** True when a gain only wins back what the opponent's last move took. */
function winsBack(swing: MaterialSwing, pending: AppliedMove | null): boolean {
  return pending !== null && pending.captured !== null && swing.net <= PIECE_VALUES[pending.captured];
}

// ---------------------------------------------------------------------------------------------
// The sentences

/** "4...Qxf2# " style prefix: the line from the opponent's reply up to and including `last`. */
function afterLine(context: Context, last: number): string {
  return `After ${formatLine(sansOf(context.played.slice(1, last + 1)), context.ply + 1)}`;
}

/** What the engine's line after the played move does to the user, in one sentence (or null). */
function playedConsequence(context: Context): string | null {
  const { move, score, played, user, grade } = context;
  if (move.checkmate) {
    return "It gives checkmate.";
  }
  // A mate in one is read from the rules, whatever line the engine printed.
  const mates = matingMoves(move.fenAfter);
  if (mates.length > 0) {
    const reply = mates.find((candidate) => candidate.uci === played[1]?.uci) ?? mates[0];
    return `After ${moveLabel(context.ply + 1, reply.san)} you are checkmated.`;
  }
  const mateIndex = played.findIndex((candidate, index) => index > 0 && index < REPLY_PLIES && candidate.checkmate);
  const mate = score.played.mate;
  if (mate !== null && mate < 0) {
    if (mateIndex > 0 && played[mateIndex].color !== user) {
      return `${afterLine(context, mateIndex)} you are checkmated.`;
    }
    return `It allows a forced mate in ${-mate}.`;
  }
  if (mate !== null && mate > 0) {
    if (mateIndex > 0 && played[mateIndex].color === user) {
      return `It forces mate: ${formatLine(sansOf(played.slice(1, mateIndex + 1)), context.ply + 1)}.`;
    }
    return `It starts a forced mate in ${mate}.`;
  }
  if (score.best.mate !== null && score.best.mate > 0) {
    return "It misses a forced mate.";
  }

  const swing = materialSwing(played, user);
  if (swing && swing.net <= -MATERIAL_MIN_PAWNS) {
    const prefix = swing.lastCapture >= 1 ? afterLine(context, swing.lastCapture) : "With best play";
    return grade === "sound"
      ? `${prefix} you give up ${lossObject(swing)}, but the engine judges that you get enough play for it.`
      : `${prefix} you lose ${lossObject(swing)}.`;
  }
  const bestSwing = materialSwing(context.best, user);
  if (context.pending && bestSwing && bestSwing.net >= MATERIAL_MIN_PAWNS && (swing?.net ?? 0) < bestSwing.net && grade !== "sound") {
    return `It does not win back the ${pieceName(context.pending.captured ?? "p")}.`;
  }
  // A gain in the line of a weaker move is usually temporary or bait; it is only mentioned when the move itself takes something.
  if (swing && swing.net >= MATERIAL_MIN_PAWNS && (grade === "sound" || move.captured !== null)) {
    const verb = winsBack(swing, context.pending) ? "win back" : "win";
    const tail = grade === "sound" ? "." : ", but the opponent gets active play for it.";
    return swing.lastCapture >= 1
      ? `${afterLine(context, swing.lastCapture)} you ${verb} ${gainObject(swing)}${tail}`
      : `It ${verb === "win" ? "wins" : "wins back"} ${gainObject(swing)}${tail}`;
  }
  if (grade === "sound") {
    return null;
  }
  // The balance is always set against the engine's choice, so "roughly equal" after a real mistake
  // does not read as if nothing was lost, and "still better" does not read as praise.
  const after = describeBalance(score.played.winPct);
  const instead = describeBalance(score.best.winPct);
  const balance =
    score.played.winPct >= BALANCE_BANDS.slightlyBetter
      ? `${after.replace("you are ", "you are still ")}, though less so than after the engine's choice`
      : after === instead
        ? `${after}, but worse for you than after the engine's choice`
        : `${after}; after the engine's choice ${instead.replace("you are ", "you would be ").replace("the position is ", "it would be ")}`;
  const reply = played[1];
  return reply ? `After ${moveLabel(context.ply + 1, reply.san)} ${balance}.` : `With best play ${balance}.`;
}

/** "The engine prefers 4.e3: it stops the mate threat on f2." */
function preferenceSentence(context: Context): string | null {
  const label = moveLabel(context.ply, context.score.best.san);
  const phrase = bestMovePhrase(context);
  const lead = context.grade === "sound" ? `The engine's first choice is ${label}` : `The engine prefers ${label}`;
  return phrase ? `${lead}: ${phrase}.` : `${lead}.`;
}

/** What the engine's preferred move does, as "it …" (null when the best line does not replay). */
function bestMovePhrase(context: Context): string | null {
  const { best, history, user, move } = context;
  const first = best[0];
  if (!first) {
    return null;
  }
  if (first.checkmate) {
    return "it gives checkmate";
  }
  if (context.score.best.mate !== null && context.score.best.mate > 0) {
    return `it starts a forced mate in ${context.score.best.mate}`;
  }
  const passed = passTurn(move.fenBefore);
  const threat = passed ? matingMoves(passed)[0] : undefined;
  if (threat && matingMoves(first.fenAfter).length === 0) {
    return `it stops the mate threat on ${threat.to}`;
  }

  const features = describeMove(first, history);
  const swing = materialSwing(best, user);
  if (swing && swing.net >= MATERIAL_MIN_PAWNS) {
    if (winsBack(swing, context.pending)) {
      return features.isRecapture ? `it recaptures on ${first.to}` : `it wins back ${gainObject(swing)}`;
    }
    return `it wins ${gainObject(swing)}`;
  }
  if (features.isRecapture) {
    return `it recaptures on ${first.to}`;
  }
  const looseAfter = new Set(loosePieces(first.fenAfter, user).map((loose) => loose.square));
  const protectedPiece = loosePieces(move.fenBefore, user).find((loose) => loose.square !== first.from && !looseAfter.has(loose.square));
  if (protectedPiece) {
    return `it protects the ${pieceName(protectedPiece.piece)} on ${protectedPiece.square}`;
  }
  if (first.castle) {
    return "it castles and brings your king to safety";
  }
  if (swing && swing.net <= -MATERIAL_MIN_PAWNS) {
    return `it gives up ${lossObject(swing)} for active play`;
  }
  const targets = features.attacks.filter((target) => !target.startsWith("king "));
  targets.sort((left, right) => byValue(pieceSymbolOf(left), pieceSymbolOf(right)) || (left < right ? -1 : 1));
  const name = features.pieceName;
  if (first.piece !== "p" && first.piece !== "k" && wasAttacked(first) && !isAttackedAfter(first)) {
    return `it moves the ${name} out of attack`;
  }
  if (features.isDevelopingMove) {
    return targets.length > 0 ? `it develops the ${name} and attacks the ${targets[0]}` : `it develops the ${name}`;
  }
  if (targets.length > 1 && first.captured === null) {
    return `it attacks both the ${targets[0]} and the ${targets[1]}`;
  }
  if (targets.length === 1 && first.captured === null) {
    return `it attacks the ${targets[0]}`;
  }
  if (first.captured !== null) {
    return `it takes the ${pieceName(first.captured)} on ${first.to}`;
  }
  if (features.isCentralPawnMove) {
    return "it fights for the centre";
  }
  if (features.isFianchetto) {
    return first.piece === "p" ? "it prepares to fianchetto the bishop" : "it puts the bishop on the long diagonal";
  }
  if (first.check) {
    return "it gives check";
  }
  if (first.piece === "p") {
    return features.region === "centre" ? "it gains space in the centre" : `it gains space on the ${features.region}`;
  }
  if (first.piece === "k") {
    return "it improves the king's position";
  }
  return `it brings the ${name} to a more active square`;
}

const NAME_TO_SYMBOL: Record<string, PieceSymbol> = { pawn: "p", knight: "n", bishop: "b", rook: "r", queen: "q", king: "k" };

/** The piece of a describeMove attack entry such as "knight on f6". */
function pieceSymbolOf(target: string): PieceSymbol {
  return NAME_TO_SYMBOL[target.split(" ")[0]] ?? "p";
}

/** The pieces of `color` (not the king) that the opponent attacks and nothing defends, most valuable first, then by square. */
function loosePieces(fen: string, color: Color): { square: Square; piece: PieceSymbol }[] {
  let chess: Chess;
  try {
    chess = new Chess(fenOf(fen));
  } catch {
    return [];
  }
  const own = colorCode(color);
  const enemy = colorCode(opposite(color));
  const loose: { square: Square; piece: PieceSymbol }[] = [];
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.color === own && cell.type !== "k" && chess.isAttacked(cell.square, enemy) && !chess.isAttacked(cell.square, own)) {
        loose.push({ square: cell.square, piece: cell.type });
      }
    }
  }
  return loose.sort((left, right) => byValue(left.piece, right.piece) || (left.square < right.square ? -1 : 1));
}

/** True when a piece of the other side attacks `square` (pins ignored: a pinned attacker still counts). */
function attackedByOpponent(fen: string, square: Square, color: Color): boolean {
  try {
    return new Chess(fenOf(fen)).isAttacked(square, colorCode(opposite(color)));
  } catch {
    return false;
  }
}

function wasAttacked(move: AppliedMove): boolean {
  return attackedByOpponent(move.fenBefore, move.from, move.color);
}

function isAttackedAfter(move: AppliedMove): boolean {
  return attackedByOpponent(move.fenAfter, move.to, move.color);
}

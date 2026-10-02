import { Chess, type PieceSymbol, type Square } from "chess.js";
import type { Idea } from "../content/schema";
import { colorCode, fenOf, opposite, type AppliedMove } from "./position";

// What a move does, in terms a hint or an explanation can use without naming the move: the piece,
// the area of the board, and whether it develops, castles, fights for the centre or gains time.

export type Region = "queenside" | "centre" | "kingside";

export interface MoveFeatures {
  piece: PieceSymbol;
  pieceName: string;
  from: Square;
  to: Square;
  /** The area of the target square. */
  region: Region;
  isCapture: boolean;
  isCheck: boolean;
  castle: "short" | "long" | null;
  isPawnMove: boolean;
  /** A c-, d-, e- or f-pawn moving to (or capturing on) ranks 3 to 6. */
  isCentralPawnMove: boolean;
  /** A knight or bishop leaving its original square. */
  isDevelopingMove: boolean;
  /** b/g pawn one step (b3, g3, b6, g6), or a bishop to b2, g2, b7 or g7. */
  isFianchetto: boolean;
  isQueenMove: boolean;
  isKingMove: boolean;
  /** Captures on the square where the previous move captured. */
  isRecapture: boolean;
  /** This piece already moved earlier in `history`. */
  isRepeatMove: boolean;
  /** Opponent pieces (not pawns) the moved piece attacks afterwards, e.g. "knight on f6". */
  attacks: string[];
}

const PIECE_NAMES: Record<PieceSymbol, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

const HOME_SQUARES: Record<"w" | "b", Partial<Record<PieceSymbol, string[]>>> = {
  w: { n: ["b1", "g1"], b: ["c1", "f1"] },
  b: { n: ["b8", "g8"], b: ["c8", "f8"] }
};

const FIANCHETTO_BISHOP_SQUARES = new Set(["b2", "g2", "b7", "g7"]);
const FIANCHETTO_PAWN_MOVES = new Set(["b2b3", "g2g3", "b7b6", "g7g6"]);

export function pieceName(piece: PieceSymbol): string {
  return PIECE_NAMES[piece];
}

/** Files a-c are the queenside, d-e the centre, f-h the kingside. */
export function squareRegion(square: string): Region {
  const file = square[0];
  if (file <= "c") {
    return "queenside";
  }
  if (file <= "e") {
    return "centre";
  }
  return "kingside";
}

function regionOf(move: AppliedMove): Region {
  if (move.castle) {
    return move.castle === "short" ? "kingside" : "queenside";
  }
  const rank = Number(move.to[1]);
  // A c- or f-pawn on ranks 3-6 fights for the centre too.
  if (move.piece === "p" && (move.to[0] === "c" || move.to[0] === "f") && rank >= 3 && rank <= 6) {
    return "centre";
  }
  return squareRegion(move.to);
}

/** Squares a piece stood on before its move in `history`, so "has it moved before" can be answered. */
function movedBefore(move: AppliedMove, history: readonly AppliedMove[]): boolean {
  return history.some((earlier) => earlier.color === move.color && earlier.to === move.from);
}

function attackedPieces(move: AppliedMove): string[] {
  let chess: Chess;
  try {
    chess = new Chess(fenOf(move.fenAfter));
  } catch {
    return [];
  }
  const mover = colorCode(move.color);
  const enemy = colorCode(opposite(move.color));
  const result: string[] = [];
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== enemy || cell.type === "p") {
        continue;
      }
      if (chess.attackers(cell.square, mover).includes(move.to)) {
        result.push(`${PIECE_NAMES[cell.type]} on ${cell.square}`);
      }
    }
  }
  return result.sort();
}

export function describeMove(move: AppliedMove, history: readonly AppliedMove[]): MoveFeatures {
  const code = colorCode(move.color);
  const rank = Number(move.to[1]);
  const previous = history[history.length - 1];
  const isPawnMove = move.piece === "p";
  return {
    piece: move.piece,
    pieceName: PIECE_NAMES[move.piece],
    from: move.from,
    to: move.to,
    region: regionOf(move),
    isCapture: move.captured !== null,
    isCheck: move.check,
    castle: move.castle,
    isPawnMove,
    isCentralPawnMove: isPawnMove && "cdef".includes(move.to[0]) && rank >= 3 && rank <= 6,
    isDevelopingMove: (move.piece === "n" || move.piece === "b") && (HOME_SQUARES[code][move.piece] ?? []).includes(move.from),
    isFianchetto: FIANCHETTO_PAWN_MOVES.has(move.uci) || (move.piece === "b" && FIANCHETTO_BISHOP_SQUARES.has(move.to)),
    isQueenMove: move.piece === "q",
    isKingMove: move.piece === "k",
    isRecapture: move.captured !== null && previous !== undefined && previous.captured !== null && previous.to === move.to,
    isRepeatMove: movedBefore(move, history),
    attacks: move.castle ? [] : attackedPieces(move)
  };
}

/** The most likely idea of a move, for a generic first hint. */
export function guessIdea(features: MoveFeatures): Idea {
  if (features.castle) {
    return "king-safety";
  }
  if (features.isRecapture) {
    return "recapture";
  }
  if (features.isDevelopingMove || features.isFianchetto) {
    return "development";
  }
  if (features.isCentralPawnMove) {
    return "centre";
  }
  if (features.attacks.length > 0 && !features.isCapture) {
    return "tempo";
  }
  if (features.isPawnMove) {
    return "flank";
  }
  return "activity";
}

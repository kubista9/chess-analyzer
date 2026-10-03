import { Chess } from "chess.js";
import { describeMove } from "./features";
import { colorCode, fenOf, type AppliedMove, type Color } from "./position";

// Opening principles as checks on a single move: fight for the centre, develop the knights and
// bishops, do not move one piece repeatedly or bring the queen out early without a concrete
// reason, castle early and keep the king's pawn shelter, and do not block your own pieces. Used
// to explain, in plain words, why a move outside the repertoire may be weaker; never as a
// verdict by itself.

/** Principle checks only apply in the opening: the first this-many plies. */
export const OPENING_PLIES = 30;

export type PrincipleId =
  | "early-queen"
  | "same-piece-twice"
  | "king-moved"
  | "castling-rights-lost"
  | "flank-pawn"
  | "neglects-development"
  | "king-shelter"
  | "blocks-own-piece";

export interface PrincipleNote {
  id: PrincipleId;
  text: string;
}

const MINOR_HOMES: Record<Color, { square: string; type: "n" | "b" }[]> = {
  white: [
    { square: "b1", type: "n" },
    { square: "g1", type: "n" },
    { square: "c1", type: "b" },
    { square: "f1", type: "b" }
  ],
  black: [
    { square: "b8", type: "n" },
    { square: "g8", type: "n" },
    { square: "c8", type: "b" },
    { square: "f8", type: "b" }
  ]
};

export interface DevelopmentState {
  /** Knights and bishops no longer on their original squares (0-4). */
  minorsDeveloped: number;
  /** The king stands on a castled square (g1/c1 or g8/c8, or b1/b8 after a long castle and Kb1). */
  castled: boolean;
  /** The king has left its original square without being on a castled square. */
  kingMoved: boolean;
}

export function developmentState(fen: string, color: Color): DevelopmentState {
  let chess: Chess;
  try {
    chess = new Chess(fenOf(fen));
  } catch {
    return { minorsDeveloped: 0, castled: false, kingMoved: false };
  }
  const code = colorCode(color);
  let atHome = 0;
  for (const home of MINOR_HOMES[color]) {
    const piece = chess.get(home.square as Parameters<Chess["get"]>[0]);
    if (piece && piece.color === code && piece.type === home.type) {
      atHome += 1;
    }
  }
  const rank = color === "white" ? "1" : "8";
  let kingSquare = "";
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.type === "k" && cell.color === code) {
        kingSquare = cell.square;
      }
    }
  }
  const castled = [`g${rank}`, `c${rank}`, `b${rank}`, `h${rank}`].includes(kingSquare);
  return { minorsDeveloped: 4 - atHome, castled, kingMoved: kingSquare !== `e${rank}` && !castled };
}

function castlingRights(fen: string, color: Color): string {
  const field = fen.split(" ")[2] ?? "-";
  return [...field].filter((char) => (color === "white" ? char === char.toUpperCase() : char === char.toLowerCase()) && char !== "-").join("");
}

/** Principle notes for `move` (played after `history`), in a fixed order; empty outside the opening. */
export function principleNotes(move: AppliedMove, history: readonly AppliedMove[]): PrincipleNote[] {
  if (history.length >= OPENING_PLIES) {
    return [];
  }
  const notes: PrincipleNote[] = [];
  const features = describeMove(move, history);
  const before = developmentState(move.fenBefore, move.color);
  const ownMovesBefore = history.filter((earlier) => earlier.color === move.color).length;
  // A capture, a check or moving a piece that was attacked is a concrete reason in itself.
  const forcing = move.captured !== null || move.check || wasAttacked(move);

  if (move.piece === "q" && !forcing && ownMovesBefore < 8 && before.minorsDeveloped < 3) {
    notes.push({ id: "early-queen", text: "It brings the queen out early, where the opponent's minor pieces can chase it and gain time." });
  }
  if (features.isRepeatMove && move.piece !== "p" && move.piece !== "k" && move.piece !== "q" && !forcing && before.minorsDeveloped < 4) {
    notes.push({ id: "same-piece-twice", text: "It moves the same piece again while other pieces are still at home." });
  }
  if (move.piece === "k" && !move.castle && castlingRights(move.fenBefore, move.color) !== "") {
    notes.push({ id: "king-moved", text: "Moving the king gives up the right to castle and leaves it in the centre." });
  } else if (move.piece === "r" && castlingRights(move.fenAfter, move.color).length < castlingRights(move.fenBefore, move.color).length && !before.castled) {
    notes.push({ id: "castling-rights-lost", text: "This rook move gives up castling on that side." });
  }
  const file = move.to[0];
  if (move.piece === "p" && (file === "a" || file === "h") && before.minorsDeveloped < 2 && !forcing) {
    notes.push({ id: "flank-pawn", text: "An edge pawn move does little for the centre or for development." });
  } else if (
    !features.isDevelopingMove &&
    !move.castle &&
    !features.isCentralPawnMove &&
    !features.isFianchetto &&
    !forcing &&
    move.piece !== "q" &&
    ownMovesBefore >= 4 &&
    before.minorsDeveloped <= 1
  ) {
    notes.push({ id: "neglects-development", text: "Most of your knights and bishops are still at home; developing them comes first." });
  }
  if (move.piece === "p" && "fgh".includes(file) && before.castled && isShortCastled(move.fenBefore, move.color)) {
    notes.push({ id: "king-shelter", text: "This pawn move loosens the shelter in front of your castled king." });
  }
  if ((move.piece === "b" || move.piece === "n") && blocksCentrePawn(move)) {
    notes.push({ id: "blocks-own-piece", text: "The piece stands in front of an unmoved centre pawn, which shuts in your other pieces." });
  }
  return notes;
}

function wasAttacked(move: AppliedMove): boolean {
  try {
    const chess = new Chess(fenOf(move.fenBefore));
    return chess.isAttacked(move.from, colorCode(move.color === "white" ? "black" : "white"));
  } catch {
    return false;
  }
}

function isShortCastled(fen: string, color: Color): boolean {
  const rank = color === "white" ? "1" : "8";
  try {
    const chess = new Chess(fenOf(fen));
    const code = colorCode(color);
    return [`g${rank}`, `h${rank}`].some((square) => {
      const piece = chess.get(square as Parameters<Chess["get"]>[0]);
      return piece?.type === "k" && piece.color === code;
    });
  } catch {
    return false;
  }
}

function blocksCentrePawn(move: AppliedMove): boolean {
  const white = move.color === "white";
  const targets: Record<string, string> = white ? { d3: "d2", e3: "e2" } : { d6: "d7", e6: "e7" };
  const pawnSquare = targets[move.to];
  if (!pawnSquare) {
    return false;
  }
  try {
    const pawn = new Chess(fenOf(move.fenAfter)).get(pawnSquare as Parameters<Chess["get"]>[0]);
    return pawn?.type === "p" && pawn.color === colorCode(move.color);
  } catch {
    return false;
  }
}

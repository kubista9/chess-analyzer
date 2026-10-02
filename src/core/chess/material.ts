import { Chess, type PieceSymbol } from "chess.js";
import { fenOf } from "./position";

// Material from the board itself (not from the move history), so positions set up from a FEN and
// promotions count correctly.

export const PIECE_VALUES: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

const START_COUNTS: Record<Exclude<PieceSymbol, "k">, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const ORDER: PieceSymbol[] = ["q", "r", "b", "n", "p"];

export interface MaterialState {
  /** Black pieces missing from the board (taken by White), most valuable first. */
  capturedByWhite: PieceSymbol[];
  /** White pieces missing from the board (taken by Black), most valuable first. */
  capturedByBlack: PieceSymbol[];
  /** White's material minus Black's, in pawns. */
  balance: number;
}

export function materialState(fen: string): MaterialState {
  const counts = { w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 } };
  let board;
  try {
    board = new Chess(fenOf(fen)).board();
  } catch {
    return { capturedByWhite: [], capturedByBlack: [], balance: 0 };
  }
  for (const row of board) {
    for (const cell of row) {
      if (cell) {
        counts[cell.color][cell.type] += 1;
      }
    }
  }

  const missing = (color: "w" | "b"): PieceSymbol[] => {
    const own = counts[color];
    // A promoted piece shows up as an extra queen (or other piece): it cancels a missing pawn.
    let promotedExtras = 0;
    for (const piece of ["n", "b", "r", "q"] as const) {
      promotedExtras += Math.max(0, own[piece] - START_COUNTS[piece]);
    }
    const result: PieceSymbol[] = [];
    for (const piece of ORDER) {
      let gone = Math.max(0, START_COUNTS[piece as Exclude<PieceSymbol, "k">] - own[piece]);
      if (piece === "p") {
        gone = Math.max(0, gone - promotedExtras);
      }
      for (let index = 0; index < gone; index += 1) {
        result.push(piece);
      }
    }
    return result;
  };

  const total = (color: "w" | "b") => ORDER.reduce((sum, piece) => sum + counts[color][piece] * PIECE_VALUES[piece], 0);

  return { capturedByWhite: missing("b"), capturedByBlack: missing("w"), balance: total("w") - total("b") };
}

import type { PieceSymbol } from "chess.js";
import { materialState } from "../../core/chess/material";
import type { Color } from "../../core/chess/position";

const GLYPHS: Record<"w" | "b", Record<PieceSymbol, string>> = {
  w: { p: "♙", n: "♘", b: "♗", r: "♖", q: "♕", k: "♔" },
  b: { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" }
};

const NAMES: Record<PieceSymbol, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

function describe(pieces: readonly PieceSymbol[]): string {
  if (pieces.length === 0) {
    return "nothing";
  }
  const counts = new Map<PieceSymbol, number>();
  for (const piece of pieces) {
    counts.set(piece, (counts.get(piece) ?? 0) + 1);
  }
  return [...counts.entries()].map(([piece, count]) => `${count} ${NAMES[piece]}${count > 1 ? "s" : ""}`).join(", ");
}

/**
 * The pieces `side` has captured (drawn in the opponent's colour) and the material lead, e.g.
 * "♟♟ +1". Shown above and below the board.
 */
export function CapturedPieces({ fen, side }: { fen: string; side: Color }) {
  const state = materialState(fen);
  const pieces = side === "white" ? state.capturedByWhite : state.capturedByBlack;
  const lead = side === "white" ? state.balance : -state.balance;
  const glyphColour = side === "white" ? "b" : "w";
  return (
    <div className="captured" aria-label={`${side === "white" ? "White" : "Black"} has captured ${describe(pieces)}${lead > 0 ? `, ${lead} up in material` : ""}`}>
      <span className="captured-pieces" aria-hidden="true">
        {pieces.map((piece, index) => (
          <span key={index}>{GLYPHS[glyphColour][piece]}</span>
        ))}
      </span>
      {lead > 0 ? (
        <span className="captured-lead tabular" aria-hidden="true">
          +{lead}
        </span>
      ) : null}
    </div>
  );
}

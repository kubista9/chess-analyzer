// EPD = the first four FEN fields (placement, side to move, castling, en passant), with the
// move clocks dropped, so transpositions share one key. chess.js 1.4 writes the en-passant
// square only when a capture is actually legal, which matches lichess's position keys.

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function toEpd(fen: string): string {
  const fields = fen.trim().split(/\s+/);
  if (fields.length < 4) {
    throw new Error(`Not a FEN: "${fen}"`);
  }

  return fields.slice(0, 4).join(" ");
}

export const START_EPD = toEpd(START_FEN);

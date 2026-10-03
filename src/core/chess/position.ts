import { Chess, type Move, type PieceSymbol, type Square } from "chess.js";

// Position keys and move application. Every rule of chess comes from chess.js; this module only
// wraps it in the shapes the trainer uses.
//
// EPD = the first four FEN fields (placement, side to move, castling, en passant) with the move
// clocks dropped, so transpositions share one key. chess.js 1.4 writes the en-passant square only
// when a capture is actually legal, which matches lichess's position keys (and keeps progress
// keys stable across move orders).

export type Color = "white" | "black";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function toEpd(fen: string): string {
  const fields = fen.trim().split(/\s+/);
  if (fields.length < 4) {
    throw new Error(`Not a FEN: "${fen}"`);
  }
  return fields.slice(0, 4).join(" ");
}

export const START_EPD = toEpd(START_FEN);

/** A full FEN for an EPD (clocks reset), or the FEN itself when it already has six fields. */
export function fenOf(epdOrFen: string): string {
  const fields = epdOrFen.trim().split(/\s+/);
  return fields.length >= 6 ? epdOrFen.trim() : `${fields.slice(0, 4).join(" ")} 0 1`;
}

/** Whose move it is in a FEN or EPD. */
export function sideToMove(epdOrFen: string): Color {
  return epdOrFen.trim().split(/\s+/)[1] === "b" ? "black" : "white";
}

export function opposite(color: Color): Color {
  return color === "white" ? "black" : "white";
}

/** "w"/"b" as used by chess.js. */
export function colorCode(color: Color): "w" | "b" {
  return color === "white" ? "w" : "b";
}

/** A legal move with everything the trainer needs to show, judge and replay it. */
export interface AppliedMove {
  from: Square;
  to: Square;
  /** e.g. "e2e4", "e7e8q". */
  uci: string;
  san: string;
  color: Color;
  piece: PieceSymbol;
  captured: PieceSymbol | null;
  promotion: PieceSymbol | null;
  castle: "short" | "long" | null;
  check: boolean;
  checkmate: boolean;
  fenBefore: string;
  fenAfter: string;
  epdBefore: string;
  epdAfter: string;
}

export type MoveInput = string | { from: string; to: string; promotion?: string };

export class IllegalMoveError extends Error {
  constructor(
    message: string,
    readonly index: number,
    readonly move: string
  ) {
    super(message);
    this.name = "IllegalMoveError";
  }
}

function toApplied(move: Move, fenAfter: string, checkmate: boolean): AppliedMove {
  const castle = move.isKingsideCastle() ? "short" : move.isQueensideCastle() ? "long" : null;
  return {
    from: move.from,
    to: move.to,
    uci: `${move.from}${move.to}${move.promotion ?? ""}`,
    san: move.san,
    color: move.color === "w" ? "white" : "black",
    piece: move.piece,
    captured: move.captured ?? null,
    promotion: move.promotion ?? null,
    castle,
    check: move.san.includes("+") || move.san.includes("#"),
    checkmate,
    fenBefore: move.before,
    fenAfter,
    epdBefore: toEpd(move.before),
    epdAfter: toEpd(fenAfter)
  };
}

const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
/** The piece a SAN or long-algebraic promotion names: "e8=Q", "e8Q", "e7e8=N+", "exd8=R#". */
const PROMOTION_SUFFIX = /[a-h][18]=?([qrbnQRBN])[+#]?$/;

/**
 * Strips annotation glyphs and a leading move number a human might type or paste ("Nf3!?",
 * "Bg2??", "1.e4!", "2...Nc6", "2…Nc6", "3. Nc3").
 */
export function cleanSan(san: string): string {
  return san
    .trim()
    .replace(/^\d+\s*(?:\.+|…)\s*/u, "")
    .replace(/[!?]+$/u, "")
    .trim();
}

/**
 * Plays one move on a position. `move` is SAN ("Nf3", "O-O", "exd5"), UCI ("g1f3", "e7e8q") or
 * {from, to, promotion}. Returns null for an illegal or unparsable move. A promotion must name
 * its piece ("e7e8" or "e7-e8" alone is not a move).
 */
export function applyMove(fen: string, move: MoveInput): AppliedMove | null {
  let chess: Chess;
  try {
    chess = new Chess(fenOf(fen));
  } catch {
    return null;
  }
  try {
    let played: Move;
    if (typeof move === "string") {
      const text = cleanSan(move);
      if (UCI_PATTERN.test(text)) {
        played = chess.move({ from: text.slice(0, 2), to: text.slice(2, 4), promotion: text[4] });
      } else {
        played = chess.move(text);
        // chess.js's permissive parser turns "e7-e8" or "e7e8k" into some promotion (a knight):
        // only accept a promotion whose piece the text actually names.
        if (played.promotion && PROMOTION_SUFFIX.exec(text)?.[1].toLowerCase() !== played.promotion) {
          return null;
        }
      }
    } else {
      played = chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    }
    return toApplied(played, chess.fen(), chess.isCheckmate());
  } catch {
    return null;
  }
}

/**
 * Replays SAN (or UCI) moves from `startFen` and returns every move. Throws IllegalMoveError with
 * the 0-based index of the first move that is not legal.
 */
export function replayMoves(moves: readonly string[], startFen: string = START_FEN): AppliedMove[] {
  const played: AppliedMove[] = [];
  let fen = startFen;
  moves.forEach((text, index) => {
    const move = applyMove(fen, text);
    if (!move) {
      throw new IllegalMoveError(`Move ${index + 1} ("${text}") is not legal in ${fen}`, index, text);
    }
    played.push(move);
    fen = move.fenAfter;
  });
  return played;
}

/** All legal moves of a position (empty for an invalid FEN). */
export function legalMoves(fen: string): AppliedMove[] {
  let chess: Chess;
  try {
    chess = new Chess(fenOf(fen));
  } catch {
    return [];
  }
  return chess.moves({ verbose: true }).map((move) => {
    const after = new Chess(move.after);
    return toApplied(move, move.after, after.isCheckmate());
  });
}

/** Legal target squares for the piece on `square` (for click-to-move dots). */
export function legalTargets(fen: string, square: string): Square[] {
  try {
    return new Chess(fenOf(fen)).moves({ square: square as Square, verbose: true }).map((move) => move.to);
  } catch {
    return [];
  }
}

/** True when a pawn move from `from` to `to` would promote (so the board must ask for a piece). */
export function isPromotion(fen: string, from: string, to: string): boolean {
  try {
    return new Chess(fenOf(fen))
      .moves({ square: from as Square, verbose: true })
      .some((move) => move.to === to && move.promotion !== undefined);
  } catch {
    return false;
  }
}

/** The square of the king of the side to move when it is in check, else null. */
export function checkedKingSquare(fen: string): Square | null {
  let chess: Chess;
  try {
    chess = new Chess(fenOf(fen));
  } catch {
    return null;
  }
  if (!chess.inCheck()) {
    return null;
  }
  const turn = chess.turn();
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.type === "k" && cell.color === turn) {
        return cell.square;
      }
    }
  }
  return null;
}

/** True when the FEN parses and describes a legal position (chess.js validation). */
export function isValidFen(fen: string): boolean {
  try {
    new Chess(fenOf(fen));
    return true;
  } catch {
    return false;
  }
}

/** UCI to SAN in a position, or null if the move is not legal there. */
export function uciToSan(fen: string, uci: string): string | null {
  return applyMove(fen, uci)?.san ?? null;
}

/** SAN to UCI in a position, or null if the move is not legal there. */
export function sanToUci(fen: string, san: string): string | null {
  return applyMove(fen, san)?.uci ?? null;
}

/** The position after a list of moves from the start (SAN or UCI). Throws on an illegal move. */
export function fenAfter(moves: readonly string[], startFen: string = START_FEN): string {
  const played = replayMoves(moves, startFen);
  return played.length === 0 ? fenOf(startFen) : played[played.length - 1].fenAfter;
}

/** Game-over state of a position, for sparring. */
export function gameState(fen: string): "checkmate" | "stalemate" | "draw" | null {
  let chess: Chess;
  try {
    chess = new Chess(fenOf(fen));
  } catch {
    return null;
  }
  if (chess.isCheckmate()) {
    return "checkmate";
  }
  if (chess.isStalemate()) {
    return "stalemate";
  }
  if (chess.isDraw()) {
    return "draw";
  }
  return null;
}

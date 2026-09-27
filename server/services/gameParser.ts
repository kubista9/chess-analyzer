import { Chess, type PieceSymbol } from "chess.js";
import { classifyPhase, resolvePlayerColor } from "../../shared/chess.js";
import type { ArchiveGame, ChessPhase, PlayerColor } from "../../shared/types.js";

export interface ParsedMove {
  ply: number;
  moveNumber: number;
  san: string;
  uci: string;
  color: PlayerColor;
  phase: ChessPhase;
  fenBefore: string;
  fenAfter: string;
  piece: PieceSymbol;
  captured?: PieceSymbol;
}

export interface ParsedGame {
  moves: ParsedMove[];
}

export function parseGame(game: ArchiveGame): ParsedGame {
  const loader = new Chess();
  loader.loadPgn(game.pgn);
  const history = loader.history({ verbose: true });

  const replay = new Chess();
  const moves: ParsedMove[] = [];

  for (const [index, move] of history.entries()) {
    const fenBefore = replay.fen();
    const color: PlayerColor = replay.turn() === "w" ? "white" : "black";
    const phase = classifyPhase(fenBefore, index + 1);
    replay.move(move);

    moves.push({
      ply: index + 1,
      moveNumber: Math.ceil((index + 1) / 2),
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion ?? ""}`,
      color,
      phase,
      fenBefore,
      fenAfter: replay.fen(),
      piece: move.piece,
      captured: move.captured
    });
  }

  return { moves };
}

/** The owner's colour in this game, or null when the owner played neither side. */
export function playerColorForGame(game: ArchiveGame, owner: string): PlayerColor | null {
  return resolvePlayerColor(owner, game.white.username, game.black.username);
}

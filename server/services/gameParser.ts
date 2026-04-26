import { Chess, type PieceSymbol } from "chess.js";
import { classifyPhase } from "../../shared/chess.js";
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

export function playerColorForGame(game: ArchiveGame, username: string): PlayerColor {
  return game.white.username.toLowerCase() === username.toLowerCase() ? "white" : "black";
}

export function pieceValue(piece?: PieceSymbol): number {
  switch (piece) {
    case "p":
      return 1;
    case "n":
    case "b":
      return 3;
    case "r":
      return 5;
    case "q":
      return 9;
    default:
      return 0;
  }
}

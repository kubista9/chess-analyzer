import { Chess } from "chess.js";
import type { PlayerColor } from "../../shared/types.js";

export interface ParsedMove {
  ply: number;
  moveNumber: number;
  san: string;
  uci: string;
  color: PlayerColor;
  fenBefore: string;
  fenAfter: string;
}

export interface ParsedGame {
  moves: ParsedMove[];
}

/** Replays a full PGN with chess.js (one game at a time: the review, not the importer). */
export function parseGame(pgn: string): ParsedGame {
  const loader = new Chess();
  loader.loadPgn(pgn);
  const history = loader.history({ verbose: true });

  const moves: ParsedMove[] = history.map((move, index) => ({
    ply: index + 1,
    moveNumber: Math.ceil((index + 1) / 2),
    san: move.san,
    uci: `${move.from}${move.to}${move.promotion ?? ""}`,
    color: move.color === "w" ? "white" : "black",
    fenBefore: move.before,
    fenAfter: move.after
  }));

  return { moves };
}

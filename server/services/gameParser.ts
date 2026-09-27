import { Chess } from "chess.js";
import { resolvePlayerColor } from "../../shared/chess.js";
import type { ArchiveGame, PlayerColor } from "../../shared/types.js";

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

export function parseGame(game: ArchiveGame): ParsedGame {
  const loader = new Chess();
  loader.loadPgn(game.pgn);
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

/** Half-moves in a game's PGN. */
export function countPlies(pgn: string): number {
  const loader = new Chess();
  loader.loadPgn(pgn);
  return loader.history().length;
}

/** The owner's colour in this game, or null when the owner played neither side. */
export function playerColorForGame(game: ArchiveGame, owner: string): PlayerColor | null {
  return resolvePlayerColor(owner, game.white.username, game.black.username);
}

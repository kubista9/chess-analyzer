import { normalizeResult } from "../../shared/chess.js";
import type { ArchiveGame, HistoryGameSummary, PlayerColor } from "../../shared/types.js";
import { countPlies } from "./gameParser.js";

/** A results-only summary of one of the owner's games. No engine is involved. */
export function summarizeGame(game: ArchiveGame, color: PlayerColor): HistoryGameSummary {
  const player = color === "white" ? game.white : game.black;
  const opponent = color === "white" ? game.black : game.white;

  return {
    id: game.id,
    url: game.url,
    opponent: opponent.username,
    opponentRating: opponent.rating,
    playerRating: player.rating,
    color,
    result: normalizeResult(color, game.white.result, game.black.result),
    openingName: game.openingName,
    openingFamily: game.openingFamily,
    endTime: game.endTime,
    plies: countPlies(game.pgn),
    timeClass: game.timeClass,
    timeControl: game.timeControl
  };
}

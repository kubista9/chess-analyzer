import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import type { PlayerColor, PositionEval } from "../../shared/types.js";
import { listOpeningMoves } from "../db/games.js";
import { replayUci } from "../engine/analysePosition.js";
import { evaluateOpening, positionKey, type OpeningDeps, type OpeningItem, type OpeningPosition } from "./openingPass.js";

// A targeted engine check of one line: every position along it (and the one it reaches), with
// every move the window's games of that colour played from each, merged into one request per
// position as the backfill does. Positions the cache answers are not searched; results are
// stored in the position cache. No game_analysis row is written (the games are not fully
// analysed), so the backfill still queues those games and finds these positions cached.

export interface LineQuery {
  owner: string;
  color: PlayerColor;
  /** UCI moves from the start. */
  moves: readonly string[];
  windowStart: number;
}

export interface LineResult {
  positions: { position: OpeningPosition; evaluation: PositionEval; searched: boolean }[];
  searched: number;
}

export async function analyseLine(deps: OpeningDeps, query: LineQuery): Promise<LineResult> {
  if (query.moves.length >= OPENING_PLY_LIMIT) {
    throw new Error(`A line of at most ${OPENING_PLY_LIMIT - 1} moves`);
  }
  // Every move the colour's window games played from each (tier, EPD).
  const played = new Map<string, Set<string>>();
  for (const game of listOpeningMoves(deps.db, query.owner, query.windowStart, OPENING_PLY_LIMIT).values()) {
    if (game.color !== query.color) {
      continue;
    }
    for (const ply of game.plies) {
      const mover: PlayerColor = ply.ply % 2 === 1 ? "white" : "black";
      const key = positionKey({ tier: mover === query.color ? "owner" : "opponent", epd: ply.epdBefore });
      let moves = played.get(key);
      if (!moves) {
        moves = new Set();
        played.set(key, moves);
      }
      moves.add(ply.uci);
    }
  }

  const items: OpeningItem[] = [];
  for (let index = 0; index <= query.moves.length; index += 1) {
    const moves = query.moves.slice(0, index);
    const { epd, chess } = replayUci(moves);
    const mover: PlayerColor = index % 2 === 0 ? "white" : "black";
    const tier = mover === query.color ? "owner" : "opponent";
    const next = query.moves[index];
    const scored = new Set(played.get(positionKey({ tier, epd })) ?? []);
    if (next) {
      scored.add(next);
    }
    const san = next ? chess.move({ from: next.slice(0, 2), to: next.slice(2, 4), promotion: next[4] }).san : "";
    items.push({
      position: { index, ply: index + 1, epd, mover, tier, moves, played: next ?? "", san },
      played: [...scored]
    });
  }

  const searched = new Set<number>();
  const evals = await evaluateOpening(deps, `line:${query.color}:${query.moves.join(",")}`, items, {
    priority: "backfill",
    onEvaluated: (index, _evaluation, info) => {
      if (info.searched) {
        searched.add(index);
      }
    }
  });
  return {
    positions: items.map((item, index) => ({ position: item.position, evaluation: evals[index], searched: searched.has(index) })),
    searched: searched.size
  };
}

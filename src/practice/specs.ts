import { applyMove, replayMoves, type AppliedMove } from "../core/chess/position";
import { formatLine } from "../core/chess/format";
import { noteFor } from "../core/content/catalog";
import { userMovesAt } from "../core/content/tree";
import type { Catalog, Line, PositionItem, RepertoireTree } from "../core/content/types";
import type { ExerciseSpec } from "./useExercise";

// Builds the exercises the practice modes present, from the compiled content.

/** Next Move: find the repertoire move in a position item (any enabled repertoire move counts). */
export function positionExercise(item: PositionItem, catalog: Catalog, key: string): ExerciseSpec {
  const history = replayMoves(item.pathSans);
  const primary = applyMove(item.fen, item.expected[0].uci) as AppliedMove;
  return {
    key,
    fen: item.fen,
    ply: history.length + 1,
    history,
    expected: item.expected.map((edge) => ({ uci: edge.uci, san: edge.san })),
    primary,
    siblings: item.expected,
    note: noteFor(catalog, item.epd, primary.uci) ?? null
  };
}

/** Play the Line: the user's move at `index` (0-based ply index) of a line; only the line's own move is book. */
export function lineStepExercise(line: Line, index: number, tree: RepertoireTree, catalog: Catalog, key: string): ExerciseSpec {
  const move = line.moves[index];
  return {
    key,
    fen: move.fenBefore,
    ply: index + 1,
    history: line.moves.slice(0, index),
    expected: [{ uci: move.uci, san: move.san }],
    primary: move,
    siblings: userMovesAt(tree, move.epdBefore),
    note: noteFor(catalog, move.epdBefore, move.uci) ?? null
  };
}

/** "after 1.c4 e5 2.Nc3" for a path, or "the starting position". */
export function afterText(sans: readonly string[]): string {
  return sans.length === 0 ? "the starting position" : `after ${formatLine(sans)}`;
}

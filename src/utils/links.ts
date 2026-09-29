import type { PlayerColor } from "../../shared/types";

/** The Explorer at `moves`, with the row of `select` (a UCI move from there) highlighted. */
export function explorerHref(color: PlayerColor, moves: readonly string[], select?: string | null): string {
  const params = new URLSearchParams({ color });
  if (moves.length) {
    params.set("moves", moves.join(","));
  }
  if (select) {
    params.set("select", select);
  }
  return `/explorer?${params}`;
}

/** The alternatives panel at `moves` (an owner-to-move position), questioning `uci` (default: the repertoire's or most played move). */
export function alternativesHref(color: PlayerColor, moves: readonly string[], uci?: string | null): string {
  const params = new URLSearchParams({ color });
  if (moves.length) {
    params.set("moves", moves.join(","));
  }
  if (uci) {
    params.set("uci", uci);
  }
  return `/alternatives?${params}`;
}

/** The Train page with one card first: by its id, or by a colour and the moves to its position (fix cards). */
export function trainHref(focus: { color: PlayerColor; moves: readonly string[] } | { id: string }): string {
  const params = new URLSearchParams();
  if ("id" in focus) {
    params.set("focus", focus.id);
  } else {
    params.set("color", focus.color);
    params.set("moves", focus.moves.join(","));
  }
  return `/train?${params}`;
}

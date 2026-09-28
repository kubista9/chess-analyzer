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

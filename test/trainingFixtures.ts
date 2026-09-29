import { Chess } from "chess.js";
import { START_EPD, toEpd } from "../shared/epd.js";
import type { RepEntry } from "../shared/repertoire.js";
import type { PlayerColor } from "../shared/types.js";

// Test helpers for the training modules (imported by tests only).

/** The EPD after UCI `moves` from the start. */
export function epdAfter(moves: readonly string[]): string {
  const chess = new Chess();
  for (const uci of moves) {
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  }
  return moves.length ? toEpd(chess.fen()) : START_EPD;
}

export function sanOf(moves: readonly string[], uci: string): string {
  const chess = new Chess();
  for (const move of moves) {
    chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
  }
  return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
}

export function sansOf(moves: readonly string[]): string[] {
  return moves.map((uci, index) => sanOf(moves.slice(0, index), uci));
}

/** A repertoire entry: the owner's `uci` after `moves`. */
export function entry(color: PlayerColor, moves: readonly string[], uci: string, updatedAt = 0): RepEntry {
  return {
    color,
    epd: epdAfter(moves),
    uci,
    san: sanOf(moves, uci),
    source: "from-games",
    status: "active",
    locked: false,
    replaced: null,
    reason: null,
    note: null,
    ply: moves.length + 1,
    updatedAt
  };
}

export function repertoire(entries: readonly RepEntry[]): Map<string, RepEntry> {
  return new Map(entries.map((item) => [item.epd, item]));
}

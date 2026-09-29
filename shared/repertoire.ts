import { Chess } from "chess.js";
import { START_EPD, toEpd } from "./epd.js";
import type { TreeGame } from "./openingTree.js";
import { addGame, ageDays, eloExpected, emptyAccumulator, recencyWeight, summarize } from "./stats.js";
import type { PlayerColor } from "./types.js";

// The owner's written repertoire: per colour, one move for each owner-to-move position (EPD), so
// transposed positions share one entry. Entries live in SQLite (repertoire_entries); this module
// holds the types and the pure read-time maths: where each game leaves the repertoire, and the
// coverage and tables built from that. Nothing here is stored.

/** Entries cover the owner's moves up to this ply (move 8). */
export const REPERTOIRE_MAX_PLY = 16;
/** Coverage is reported as the share of games still in the repertoire through these plies. */
export const COVERAGE_PLIES = [8, 12] as const;
/** An unprepared opponent reply becomes a fix item from this many games. */
export const UNPREPARED_MIN_N = 3;
/** Example games per deviation / unprepared row. */
export const REPERTOIRE_EXAMPLES = 3;

/** from-games: the owner's own move; seed-engine: suggested by the seed's engine or results rules; edited: set by the owner. */
export type RepSource = "from-games" | "seed-engine" | "edited";
export type RepStatus = "active" | "needs-review";

/** The owner's move an entry replaced, and why. */
export interface RepReplaced {
  uci: string;
  san: string;
  /** Its engine loss (win%) at the root, or null when unknown. */
  loss: number | null;
  reason: string;
}

export interface RepEntry {
  color: PlayerColor;
  /** The owner-to-move position. */
  epd: string;
  uci: string;
  san: string;
  source: RepSource;
  status: RepStatus;
  /** A locked entry is never changed by a re-seed. Edited entries are never changed either. */
  locked: boolean;
  replaced: RepReplaced | null;
  /** The seed's explanation of the choice (facts only), or null for an edited entry. */
  reason: string | null;
  /** The owner's own note. */
  note: string | null;
  /** The ply of the move on the shortest path from the start (1-based). */
  ply: number;
  /** ms since the epoch. */
  updatedAt: number;
}

/** One colour's entries by EPD. */
export type ColorRepertoire = ReadonlyMap<string, RepEntry>;

/** How an owner move is labelled in the UI. */
export type RepTag = { kind: "from-games" } | { kind: "suggested"; replaces: string | null } | { kind: "edited" };

export function repTag(entry: Pick<RepEntry, "source" | "replaced">): RepTag {
  if (entry.source === "edited") {
    return { kind: "edited" };
  }
  if (entry.replaced || entry.source === "seed-engine") {
    return { kind: "suggested", replaces: entry.replaced?.san ?? null };
  }
  return { kind: "from-games" };
}

export function sideToMove(epd: string): PlayerColor {
  return epd.split(" ")[1] === "b" ? "black" : "white";
}

/** The move `uci` or `san` in `epd` as {uci, san, toEpd}, or null when it is not legal there. */
export function legalMove(epd: string, move: { uci?: string; san?: string }): { uci: string; san: string; toEpd: string } | null {
  try {
    const chess = new Chess(`${epd} 0 1`);
    const made = move.uci
      ? chess.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), promotion: move.uci[4] })
      : chess.move(move.san ?? "");
    return { uci: made.from + made.to + (made.promotion ?? ""), san: made.san, toEpd: toEpd(chess.fen()) };
  } catch {
    return null;
  }
}

/** Where a game leaves the repertoire: the owner plays another move than the entry. */
export interface Deviation {
  ply: number;
  epd: string;
  played: { uci: string; san: string };
  expected: { uci: string; san: string };
}

/** Where the repertoire runs out: the opponent's move reaches an owner position with no entry. */
export interface Unprepared {
  /** The opponent's ply. */
  ply: number;
  /** The position the opponent moved from, and his move. */
  parentEpd: string;
  opp: { uci: string; san: string };
  /** The owner-to-move position without an entry. */
  epd: string;
}

export interface RepertoireWalk {
  deviation: Deviation | null;
  unprepared: Unprepared | null;
  /** The last ply still inside the repertoire (the walk covers REPERTOIRE_MAX_PLY plies at most). */
  inRepThrough: number;
  /** False when the colour has no entry at the start (White with no root entry): nothing to measure. */
  started: boolean;
}

/**
 * Walks a game's first REPERTOIRE_MAX_PLY plies against the owner's entries. The first owner
 * move that differs from its entry is the deviation; the first opponent move into an owner
 * position without an entry is unprepared. The walk stops at whichever comes first. A game that
 * ends inside the repertoire counts as staying in it.
 */
export function walkRepertoire(game: Pick<TreeGame, "color" | "plies">, entries: ColorRepertoire, maxPly: number = REPERTOIRE_MAX_PLY): RepertoireWalk {
  const plies = game.plies.slice(0, maxPly);
  const started = game.color === "black" || entries.has(START_EPD);
  for (const [index, ply] of plies.entries()) {
    const number = index + 1;
    const ownerMoves = (number % 2 === 1) === (game.color === "white");
    if (!ownerMoves) {
      continue;
    }
    const entry = entries.get(ply.epdBefore);
    if (!entry) {
      if (index === 0) {
        return { deviation: null, unprepared: null, inRepThrough: 0, started: false };
      }
      const opp = plies[index - 1];
      return {
        deviation: null,
        unprepared: { ply: number - 1, parentEpd: opp.epdBefore, opp: { uci: opp.uci, san: opp.san }, epd: ply.epdBefore },
        inRepThrough: number - 2,
        started
      };
    }
    if (entry.uci !== ply.uci) {
      return {
        deviation: { ply: number, epd: ply.epdBefore, played: { uci: ply.uci, san: ply.san }, expected: { uci: entry.uci, san: entry.san } },
        unprepared: null,
        inRepThrough: number - 1,
        started
      };
    }
  }
  return { deviation: null, unprepared: null, inRepThrough: maxPly, started };
}

export interface RepExample {
  id: string;
  ply: number;
  score: number;
  endTime: number;
}

interface RowStats {
  n: number;
  /** Raw score 0..1. */
  score: number;
  /** Recency-weighted points below the Elo expectation (positive = lost points). */
  pointsLost: number;
  examples: RepExample[];
}

export interface DeviationRow extends RowStats {
  epd: string;
  ply: number;
  played: { uci: string; san: string };
  expected: { uci: string; san: string };
}

export interface UnpreparedRow extends RowStats {
  parentEpd: string;
  ply: number;
  opp: { uci: string; san: string };
  epd: string;
}

export interface CoverageStat {
  ply: number;
  /** Games still in the repertoire through the ply, of the games measured. */
  stayed: number;
  games: number;
  rate: number | null;
}

export interface RepertoireStats {
  color: PlayerColor;
  games: number;
  coverage: CoverageStat[];
  /** Most frequent first. */
  deviations: DeviationRow[];
  unprepared: UnpreparedRow[];
  /** Per game id: the deviation ply and the unprepared ply (null when none). */
  byGame: Map<string, { deviationPly: number | null; unpreparedPly: number | null; inRepThrough: number }>;
}

interface Group<T> {
  key: T;
  games: TreeGame[];
  plies: number[];
}

function rowStats(groupGames: readonly TreeGame[], plies: readonly number[], now: number, halfLifeDays: number | null): RowStats {
  const acc = emptyAccumulator();
  let points = 0;
  for (const game of groupGames) {
    addGame(acc, recencyWeight(ageDays(game.endTime, now), halfLifeDays), game.score, eloExpected(game.myRating, game.oppRating));
    points += game.score;
  }
  const summary = summarize(acc);
  const order = groupGames
    .map((game, index) => ({ game, ply: plies[index] }))
    .sort((a, b) => a.game.score - b.game.score || b.game.endTime - a.game.endTime || (a.game.id < b.game.id ? -1 : 1));
  return {
    n: groupGames.length,
    score: groupGames.length ? points / groupGames.length : 0,
    pointsLost: -summary.deltaPts,
    examples: order.slice(0, REPERTOIRE_EXAMPLES).map(({ game, ply }) => ({ id: game.id, ply, score: game.score, endTime: game.endTime }))
  };
}

function bySizeThenKey<T extends { n: number; pointsLost: number }>(key: (row: T) => string) {
  return (a: T, b: T) => b.n - a.n || b.pointsLost - a.pointsLost || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

/**
 * Coverage, the deviations table and the unprepared table of one colour's games against its
 * entries. `now` and `halfLifeDays` weight the points lost as the tree does.
 */
export function repertoireStats(
  color: PlayerColor,
  games: readonly TreeGame[],
  entries: ColorRepertoire,
  options: { now: number; halfLifeDays: number | null; maxPly?: number }
): RepertoireStats {
  const deviations = new Map<string, Group<Deviation>>();
  const unprepared = new Map<string, Group<Unprepared>>();
  const byGame: RepertoireStats["byGame"] = new Map();
  const walks: RepertoireWalk[] = [];
  for (const game of games) {
    const walk = walkRepertoire(game, entries, options.maxPly);
    walks.push(walk);
    byGame.set(game.id, { deviationPly: walk.deviation?.ply ?? null, unpreparedPly: walk.unprepared?.ply ?? null, inRepThrough: walk.inRepThrough });
    if (walk.deviation) {
      const key = `${walk.deviation.epd}|${walk.deviation.played.uci}`;
      const group = deviations.get(key) ?? { key: walk.deviation, games: [], plies: [] };
      group.games.push(game);
      group.plies.push(walk.deviation.ply);
      deviations.set(key, group);
    }
    if (walk.unprepared) {
      const key = `${walk.unprepared.parentEpd}|${walk.unprepared.opp.uci}`;
      const group = unprepared.get(key) ?? { key: walk.unprepared, games: [], plies: [] };
      group.games.push(game);
      group.plies.push(walk.unprepared.ply);
      unprepared.set(key, group);
    }
  }
  const measured = walks.filter((walk) => walk.started);
  const coverage = COVERAGE_PLIES.map((ply): CoverageStat => {
    const stayed = measured.filter((walk) => walk.inRepThrough >= ply).length;
    return { ply, stayed, games: measured.length, rate: measured.length ? stayed / measured.length : null };
  });
  const stats = (group: Group<unknown>) => rowStats(group.games, group.plies, options.now, options.halfLifeDays);
  return {
    color,
    games: games.length,
    coverage,
    deviations: [...deviations.values()]
      .map((group): DeviationRow => ({ ...group.key, ...stats(group) }))
      .sort(bySizeThenKey((row) => `${row.epd}|${row.played.uci}`)),
    unprepared: [...unprepared.values()]
      .map((group): UnpreparedRow => ({ ...group.key, ...stats(group) }))
      .sort(bySizeThenKey((row) => `${row.parentEpd}|${row.opp.uci}`)),
    byGame
  };
}

/** Entries as maps per colour. */
export function byColor(entries: readonly RepEntry[]): Record<PlayerColor, Map<string, RepEntry>> {
  const result: Record<PlayerColor, Map<string, RepEntry>> = { white: new Map(), black: new Map() };
  for (const entry of entries) {
    result[entry.color].set(entry.epd, entry);
  }
  return result;
}

/** A move the owner could set at an owner node: one he plays here, or the engine's. */
export interface RepOption {
  uci: string;
  san: string;
  /** His games with it here (0 for an engine-only move). */
  n: number;
  score: number | null;
  /** Engine loss (win%) at the root, or null when unknown. */
  loss: number | null;
  engineBest: boolean;
}

export interface RepChild {
  uci: string;
  san: string;
  toEpd: string;
  /** Games that played it here. */
  n: number;
  /** Its recency-weighted share of the position's games. */
  share: number;
}

/** One position of a colour's repertoire lines, as GET /api/repertoire sends it. */
export interface RepNodeView {
  epd: string;
  /** Ply of the position (0 = the start) on the walk's shortest path. */
  ply: number;
  ownerToMove: boolean;
  /** UCI and SAN moves from the start on that path. */
  moves: string[];
  sans: string[];
  /** Games that reached the position. */
  n: number;
  name: string | null;
  eco: string | null;
  /** Owner nodes: the entry, or null when the repertoire has no move here yet. */
  entry: RepEntry | null;
  /** Owner nodes with an entry: its games, score and engine loss. */
  entryStats: { n: number; score: number | null; loss: number | null } | null;
  /** Owner nodes: moves to choose from. */
  options: RepOption[];
  /** Owner nodes: the entry's move; opponent nodes: the replies the lines follow, most games first. */
  children: RepChild[];
}

export interface ColorRepertoireView {
  color: PlayerColor;
  games: number;
  entries: number;
  needsReview: number;
  /** Walk order from the start; the first node is the start position. */
  nodes: RepNodeView[];
  coverage: CoverageStat[];
  deviations: DeviationRow[];
  unprepared: UnpreparedRow[];
  /** Entries the walk from the start does not reach (e.g. after an earlier move was edited). */
  offTree: RepEntry[];
}

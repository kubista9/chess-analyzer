import { Chess } from "chess.js";
import { START_EPD, toEpd } from "../epd.js";
import { nameAt, type OpeningBook } from "../openingBook.js";
import { REPERTOIRE_MAX_PLY, sideToMove, type ColorRepertoire } from "../repertoire.js";
import type { PlayerColor } from "../types.js";
import { newState, resetForRecurrence, type DrillKind, type SrsState } from "./scheduler.js";

// Drill cards: one per (kind, colour, EPD), and never two for one (colour, EPD).
//
// - "repertoire-line": every owner-to-move repertoire position reachable from the start through
//   the repertoire (the entry's move at the owner's nodes, every legal reply that lands on an
//   entry at the opponent's) at ply <= 16. Only the repertoire move is correct.
// - "own-mistake": a position where the owner's first opening error of a game happened: the first
//   owner move with a loss >= 5 win% (inaccuracy or worse) in the first 20 plies. The engine's
//   best, anything within 3 win% of it, and a sound repertoire move are accepted. The deep tier
//   confirms the error lazily, when the card is first scheduled.
//
// Dedupe: a mistake site that is also a line node gives ONE line card, carrying the games where
// the owner went wrong there (`sources`), never a second card.

export interface MistakeSource {
  gameId: string;
  /** Unix seconds. */
  endTime: number;
  opponent: string;
  oppRating: number;
  /** The owner's move's ply (1-based). */
  ply: number;
  playedUci: string;
  playedSan: string;
  /** Owner-tier win% loss of the played move. */
  loss: number;
}

/** One game's first owner error, as found by the opening analysis. */
export interface MistakeOccurrence extends MistakeSource {
  color: PlayerColor;
  /** The position before the move. */
  epd: string;
  /** UCI and SAN moves from the start to the position. */
  pathUci: string[];
  pathSan: string[];
}

export interface CardContent {
  id: string;
  kind: DrillKind;
  color: PlayerColor;
  epd: string;
  /** The ply of the owner's move to find (1-based). */
  ply: number;
  pathUci: string[];
  pathSan: string[];
  /** The repertoire move (line cards); null for a mistake card. */
  primary: { uci: string; san: string } | null;
  lineName: string | null;
  eco: string | null;
  weight: number;
  /** Mistake cards: the games behind the card. Line cards: the games the owner went wrong here. Newest first. */
  sources: MistakeSource[];
}

export type CardStatus = "active" | "removed";
/** Line cards: "none". Mistake cards: the lazy deep check's state. */
export type ConfirmState = "none" | "pending" | "confirmed" | "rejected";

export interface DeepCheck {
  bestUci: string;
  bestSan: string;
  /** The deep-tier loss of each source's played move (worst first). */
  worstLoss: number;
  depth: number;
  checkedAt: number;
}

export interface StoredCard extends CardContent {
  status: CardStatus;
  confirm: ConfirmState;
  check: DeepCheck | null;
  srs: SrsState;
  generatedAt: number;
}

export function cardId(kind: DrillKind, color: PlayerColor, epd: string): string {
  return `${kind}|${color}|${epd}`;
}

// ---- the repertoire graph ----

export interface RepGraphNode {
  epd: string;
  /** Plies from the start on the shortest path. */
  ply: number;
  ownerToMove: boolean;
  pathUci: string[];
  pathSan: string[];
  /** EPDs from the start through this one (for book names). */
  pathEpds: string[];
}

export interface RepMove {
  uci: string;
  san: string;
  toEpd: string;
}

export interface RepGraph {
  color: PlayerColor;
  entries: ColorRepertoire;
  maxPly: number;
  /** Every node reached, breadth first (shortest paths). */
  nodes: Map<string, RepGraphNode>;
  /** Opponent nodes: the legal replies that land on an entry. Owner nodes: the entry's move. */
  moves: Map<string, RepMove[]>;
}

function fenOfEpd(epd: string): string {
  return `${epd} 0 1`;
}

/** The legal moves from `epd` with the EPD each reaches. */
export function legalMovesFrom(epd: string): RepMove[] {
  const chess = new Chess(fenOfEpd(epd));
  return chess.moves({ verbose: true }).map((move) => ({ uci: move.from + move.to + (move.promotion ?? ""), san: move.san, toEpd: toEpd(move.after) }));
}

/**
 * Walks the repertoire from the start: the entry's move at the owner's nodes, every legal reply
 * that lands on an entry at the opponent's (so no reply without a prepared answer), to `maxPly`.
 */
export function buildRepGraph(color: PlayerColor, entries: ColorRepertoire, maxPly: number = REPERTOIRE_MAX_PLY): RepGraph {
  const nodes = new Map<string, RepGraphNode>();
  const moves = new Map<string, RepMove[]>();
  const start: RepGraphNode = { epd: START_EPD, ply: 0, ownerToMove: color === "white", pathUci: [], pathSan: [], pathEpds: [START_EPD] };
  nodes.set(START_EPD, start);
  const queue: RepGraphNode[] = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    if (node.ply >= maxPly) {
      continue;
    }
    let out: RepMove[];
    if (node.ownerToMove) {
      const entry = entries.get(node.epd);
      if (!entry) {
        continue;
      }
      const toEpdAfter = legalMovesFrom(node.epd).find((move) => move.uci === entry.uci)?.toEpd;
      out = toEpdAfter ? [{ uci: entry.uci, san: entry.san, toEpd: toEpdAfter }] : [];
    } else {
      out = entries.size ? legalMovesFrom(node.epd).filter((move) => entries.has(move.toEpd)) : [];
    }
    if (!out.length) {
      continue;
    }
    moves.set(node.epd, out);
    for (const move of out) {
      if (nodes.has(move.toEpd)) {
        continue;
      }
      const child: RepGraphNode = {
        epd: move.toEpd,
        ply: node.ply + 1,
        ownerToMove: sideToMove(move.toEpd) === color,
        pathUci: [...node.pathUci, move.uci],
        pathSan: [...node.pathSan, move.san],
        pathEpds: [...node.pathEpds, move.toEpd]
      };
      nodes.set(move.toEpd, child);
      queue.push(child);
    }
  }
  return { color, entries, maxPly, nodes, moves };
}

// ---- generation ----

export interface GenerateInput {
  graphs: Record<PlayerColor, RepGraph>;
  occurrences: readonly MistakeOccurrence[];
  /** Recency-weighted games reaching a position (the opening tree's wN), 0 if never reached. */
  nodeWeight: (color: PlayerColor, epd: string) => number;
  book?: OpeningBook;
  /** Unix seconds, for recency weights. */
  now: number;
  halfLifeDays: number | null;
}

/** A line card that no game reached still gets this weight, so it is scheduled. */
export const MIN_LINE_WEIGHT = 0.5;

export function recencyWeight(endTime: number, now: number, halfLifeDays: number | null): number {
  if (!halfLifeDays) {
    return 1;
  }
  return Math.pow(0.5, Math.max(0, now - endTime) / (halfLifeDays * 86_400));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function lineName(book: OpeningBook | undefined, epds: readonly string[]): { name: string | null; eco: string | null } {
  const hit = book ? nameAt(book, epds) : null;
  return { name: hit?.name ?? null, eco: hit?.eco ?? null };
}

const bySourceOrder = (left: MistakeSource, right: MistakeSource) => right.endTime - left.endTime || left.gameId.localeCompare(right.gameId);

/** The cards the store should hold now, sorted by id. Deterministic. */
export function generateCards(input: GenerateInput): CardContent[] {
  const cards = new Map<string, CardContent>();
  for (const color of ["white", "black"] as const) {
    const graph = input.graphs[color];
    for (const node of graph.nodes.values()) {
      if (!node.ownerToMove) {
        continue;
      }
      const move = graph.moves.get(node.epd)?.[0];
      const entry = graph.entries.get(node.epd);
      if (!move || !entry) {
        continue;
      }
      const name = lineName(input.book, [...node.pathEpds, move.toEpd]);
      const id = cardId("repertoire-line", color, node.epd);
      cards.set(id, {
        id,
        kind: "repertoire-line",
        color,
        epd: node.epd,
        ply: node.ply + 1,
        pathUci: node.pathUci,
        pathSan: node.pathSan,
        primary: { uci: entry.uci, san: entry.san },
        lineName: name.name,
        eco: name.eco,
        weight: round3(Math.max(MIN_LINE_WEIGHT, input.nodeWeight(color, node.epd))),
        sources: []
      });
    }
  }

  const groups = new Map<string, MistakeOccurrence[]>();
  for (const occurrence of input.occurrences) {
    const key = `${occurrence.color}|${occurrence.epd}`;
    groups.set(key, [...(groups.get(key) ?? []), occurrence]);
  }
  for (const group of groups.values()) {
    const sorted = [...group].sort(bySourceOrder);
    const newest = sorted[0];
    const sources: MistakeSource[] = sorted.map(({ gameId, endTime, opponent, oppRating, ply, playedUci, playedSan, loss }) => ({
      gameId,
      endTime,
      opponent,
      oppRating,
      ply,
      playedUci,
      playedSan,
      loss
    }));
    const line = cards.get(cardId("repertoire-line", newest.color, newest.epd));
    if (line) {
      line.sources = sources;
      continue;
    }
    const epds = [START_EPD];
    try {
      const chess = new Chess();
      for (const uci of newest.pathUci) {
        chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        epds.push(toEpd(chess.fen()));
      }
    } catch {
      // A path that does not replay only loses its name.
    }
    const name = lineName(input.book, epds);
    const id = cardId("own-mistake", newest.color, newest.epd);
    cards.set(id, {
      id,
      kind: "own-mistake",
      color: newest.color,
      epd: newest.epd,
      ply: newest.ply,
      pathUci: newest.pathUci,
      pathSan: newest.pathSan,
      primary: null,
      lineName: name.name,
      eco: name.eco,
      weight: round3(sorted.reduce((sum, source) => sum + recencyWeight(source.endTime, input.now, input.halfLifeDays), 0)),
      sources
    });
  }
  return [...cards.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

// ---- regeneration ----

export interface MergeResult {
  /** Every card to write (new or changed), sorted by id. */
  write: StoredCard[];
  added: number;
  removed: number;
  restored: number;
  /** Cards brought back (due now, one more lapse) because their mistake recurred in a new game. */
  recurred: number;
}

function sameContent(left: CardContent, right: CardContent): boolean {
  const pick = (card: CardContent) => [card.ply, card.pathUci, card.pathSan, card.primary, card.lineName, card.eco, card.weight, card.sources];
  return JSON.stringify(pick(left)) === JSON.stringify(pick(right));
}

/**
 * Merges freshly generated cards into the stored ones. Idempotent: the same drafts give no
 * writes. SRS state and review history stay with the card id; a card no longer generated is
 * marked removed (and restored, with its state, if it comes back). A card whose mistake shows up
 * in a game played after its last review comes back due now with a lapse (a retired card too).
 */
export function mergeCards(existing: readonly StoredCard[], drafts: readonly CardContent[], nowMs: number): MergeResult {
  const byId = new Map(existing.map((card) => [card.id, card]));
  const write: StoredCard[] = [];
  let added = 0;
  let restored = 0;
  let recurred = 0;
  const seen = new Set<string>();

  for (const draft of drafts) {
    seen.add(draft.id);
    const stored = byId.get(draft.id);
    if (!stored) {
      added += 1;
      write.push({
        ...draft,
        status: "active",
        confirm: draft.kind === "own-mistake" ? "pending" : "none",
        check: null,
        srs: newState(),
        generatedAt: nowMs
      });
      continue;
    }
    const known = new Set(stored.sources.map((source) => source.gameId));
    const since = stored.srs.lastReviewAt ?? stored.srs.introducedAt ?? Number.POSITIVE_INFINITY;
    const fresh = draft.sources.filter((source) => !known.has(source.gameId) && source.endTime * 1000 > since);
    let srs = stored.srs;
    let confirm = stored.confirm;
    if (fresh.length && stored.srs.box > 0) {
      srs = resetForRecurrence(stored.srs, nowMs);
      recurred += 1;
    }
    if (fresh.length && confirm === "rejected") {
      // A new game repeats a move the deep check cleared: check again with the new move.
      confirm = "pending";
    }
    const wasRemoved = stored.status === "removed";
    if (wasRemoved) {
      restored += 1;
    }
    if (wasRemoved || srs !== stored.srs || confirm !== stored.confirm || !sameContent(stored, draft)) {
      write.push({ ...stored, ...draft, status: "active", confirm, srs, generatedAt: nowMs });
    }
  }

  let removed = 0;
  for (const card of existing) {
    if (!seen.has(card.id) && card.status === "active") {
      removed += 1;
      write.push({ ...card, status: "removed", generatedAt: nowMs });
    }
  }
  write.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { write, added, removed, restored, recurred };
}

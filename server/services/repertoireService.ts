import { START_EPD } from "../../shared/epd.js";
import type { ResultsLeakItem } from "../../shared/fixList.js";
import { rootVerdict, round2, sanOf, type EvalLookup } from "../../shared/openingAnalysis.js";
import type { OpeningTree, TreeGame } from "../../shared/openingTree.js";
import {
  REPERTOIRE_MAX_PLY,
  byColor,
  legalMove,
  repertoireStats,
  sideToMove,
  type ColorRepertoire,
  type ColorRepertoireView,
  type RepChild,
  type RepEntry,
  type RepNodeView,
  type RepOption,
  type RepStatus
} from "../../shared/repertoire.js";
import { SEED_REPLY_MIN_N, SEED_REPLY_MIN_SHARE, seedColor, seedDiff, seedFlags, type SeedDiff } from "../../shared/repertoireSeed.js";
import type { PlayerColor } from "../../shared/types.js";
import type { Db } from "../db/connection.js";
import { applySeedChanges, getRepEntry, listRepertoire, upsertRepEntry } from "../db/repertoire.js";

// The repertoire over the store: the per-colour lines for the Repertoire page, seeding (a dry-run
// diff, or applied), owner edits and the PGN export. Coverage and the tables are computed at read
// time from the stored entries, so an edit shows up at once.

/** Tables sent per colour. */
export const REPERTOIRE_TABLE_ROWS = 15;

export class RepertoireInputError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function loadRepertoire(db: Db, owner: string): Record<PlayerColor, Map<string, RepEntry>> {
  return byColor(listRepertoire(db, owner));
}

const isOwnerToMove = (epd: string, color: PlayerColor) => sideToMove(epd) === color;

/** The moves to choose from at an owner node: the owner's own, then the engine's lines. */
function optionsAt(tree: OpeningTree, epd: string, lookup: EvalLookup | null): RepOption[] {
  const evaluation = lookup?.(epd, "owner");
  const best = evaluation?.lines[0];
  const options: RepOption[] = (tree.nodes.get(epd)?.edges ?? []).map((edge) => {
    const verdict = rootVerdict(evaluation, edge.uci);
    return {
      uci: edge.uci,
      san: edge.san,
      n: edge.n,
      score: edge.raw.score,
      loss: verdict ? round2(verdict.loss) : null,
      engineBest: best?.uci === edge.uci
    };
  });
  for (const line of evaluation?.lines ?? []) {
    if (!options.some((option) => option.uci === line.uci)) {
      const verdict = rootVerdict(evaluation, line.uci);
      options.push({ uci: line.uci, san: sanOf(epd, line.uci), n: 0, score: null, loss: verdict ? round2(verdict.loss) : null, engineBest: best?.uci === line.uci });
    }
  }
  return options;
}

/**
 * One colour's repertoire lines: a breadth-first walk from the start that follows the entry at
 * owner nodes and, at opponent nodes, the replies the seed follows (SEED_REPLY_MIN_N games or a
 * SEED_REPLY_MIN_SHARE weighted share) plus any reply leading to an entry.
 */
export function colorView(
  tree: OpeningTree,
  games: readonly TreeGame[],
  entries: ColorRepertoire,
  lookup: EvalLookup | null,
  options: { now: number; halfLifeDays: number | null; tableRows?: number }
): ColorRepertoireView {
  const color = tree.color;
  const nodes: RepNodeView[] = [];
  const seen = new Set<string>([START_EPD]);
  const queue: { epd: string; ply: number; moves: string[]; sans: string[] }[] = [{ epd: START_EPD, ply: 0, moves: [], sans: [] }];
  for (let index = 0; index < queue.length; index += 1) {
    const { epd, ply, moves, sans } = queue[index];
    const node = tree.nodes.get(epd);
    const ownerToMove = isOwnerToMove(epd, color);
    const children: RepChild[] = [];
    let entry: RepEntry | null = null;
    let entryStats: RepNodeView["entryStats"] = null;
    if (ownerToMove) {
      entry = ply < REPERTOIRE_MAX_PLY ? entries.get(epd) ?? null : null;
      const move = entry && legalMove(epd, { uci: entry.uci });
      if (entry && move) {
        const edge = node?.edges.find((candidate) => candidate.uci === entry!.uci);
        const verdict = rootVerdict(lookup?.(epd, "owner"), entry.uci);
        entryStats = { n: edge?.n ?? 0, score: edge ? edge.raw.score : null, loss: verdict ? round2(verdict.loss) : null };
        children.push({ uci: move.uci, san: move.san, toEpd: move.toEpd, n: edge?.n ?? 0, share: node && node.wN > 0 && edge ? edge.weighted.wN / node.wN : 0 });
      }
    } else if (node && ply + 1 < REPERTOIRE_MAX_PLY) {
      for (const edge of node.edges) {
        const share = node.wN > 0 ? edge.weighted.wN / node.wN : 0;
        if (edge.n >= SEED_REPLY_MIN_N || share >= SEED_REPLY_MIN_SHARE || entries.has(edge.toEpd)) {
          children.push({ uci: edge.uci, san: edge.san, toEpd: edge.toEpd, n: edge.n, share });
        }
      }
    }
    nodes.push({
      epd,
      ply,
      ownerToMove,
      moves,
      sans,
      n: node?.n ?? 0,
      name: node?.name ?? null,
      eco: node?.eco ?? null,
      entry,
      entryStats,
      options: ownerToMove && ply < REPERTOIRE_MAX_PLY ? optionsAt(tree, epd, lookup) : [],
      children
    });
    for (const child of children) {
      if (!seen.has(child.toEpd)) {
        seen.add(child.toEpd);
        queue.push({ epd: child.toEpd, ply: ply + 1, moves: [...moves, child.uci], sans: [...sans, child.san] });
      }
    }
  }

  const stats = repertoireStats(color, games, entries, { now: options.now, halfLifeDays: options.halfLifeDays });
  const rows = options.tableRows ?? REPERTOIRE_TABLE_ROWS;
  const all = [...entries.values()];
  return {
    color,
    games: games.length,
    entries: all.length,
    needsReview: all.filter((entry) => entry.status === "needs-review").length,
    nodes,
    coverage: stats.coverage,
    deviations: stats.deviations.slice(0, rows),
    unprepared: stats.unprepared.slice(0, rows),
    offTree: all.filter((entry) => !seen.has(entry.epd)).sort((a, b) => a.ply - b.ply || (a.epd < b.epd ? -1 : 1))
  };
}

export interface SeedSource {
  tree: OpeningTree;
  /** Leak and watch items of the fix list (the results flags). */
  flagged: readonly ResultsLeakItem[];
}

/** The seed diff per colour against the stored entries; written when `apply`. */
export function seedRepertoire(
  db: Db,
  owner: string,
  sources: Record<PlayerColor, SeedSource>,
  lookup: EvalLookup | null,
  apply: boolean,
  now: number
): Record<PlayerColor, SeedDiff> {
  const existing = loadRepertoire(db, owner);
  const diff = {} as Record<PlayerColor, SeedDiff>;
  for (const color of ["white", "black"] as const) {
    const { tree, flagged } = sources[color];
    const seeded = seedColor({ tree, lookup, flags: seedFlags(flagged, color), existing: existing[color] });
    diff[color] = seedDiff(existing[color], seeded);
  }
  if (apply) {
    applySeedChanges(db, owner, [...diff.white.changes, ...diff.black.changes], now);
  }
  return diff;
}

export interface EntryEdit {
  color: PlayerColor;
  epd: string;
  /** The new move (UCI or SAN); omitted to change only the flags or the note. */
  uci?: string;
  san?: string;
  locked?: boolean;
  status?: RepStatus;
  note?: string | null;
  /** The move's ply on the path it was set from; required for a new entry. */
  ply?: number;
  /**
   * The move this edit replaces and why (e.g. "Set from the alternatives: …"), recorded in
   * `replaced` when the move changes. Without it the current entry's move is recorded.
   */
  replaces?: { uci: string; loss?: number | null; reason?: string };
}

function replacedBy(edit: EntryEdit, current: RepEntry | undefined, newUci: string): RepEntry["replaced"] {
  const given = edit.replaces && edit.replaces.uci !== newUci ? legalMove(edit.epd, { uci: edit.replaces.uci }) : null;
  if (edit.replaces && edit.replaces.uci !== newUci && !given) {
    throw new RepertoireInputError(400, `${edit.replaces.uci} is not a legal move in ${edit.epd}.`);
  }
  if (given) {
    return { uci: given.uci, san: given.san, loss: edit.replaces!.loss ?? null, reason: edit.replaces!.reason?.trim() || "Changed by you." };
  }
  return current ? { uci: current.uci, san: current.san, loss: null, reason: "Changed by you." } : null;
}

/**
 * The owner's edit of one entry. A new move makes it an edited, locked, active entry and records
 * the move it replaced; the same move (or none) changes only the lock, status and note.
 */
export function editEntry(db: Db, owner: string, edit: EntryEdit, now: number): RepEntry {
  if (!isOwnerToMove(edit.epd, edit.color)) {
    throw new RepertoireInputError(400, `It is not ${edit.color}'s move in ${edit.epd}.`);
  }
  const current = getRepEntry(db, owner, edit.color, edit.epd);
  let entry: RepEntry;
  if (edit.uci !== undefined || edit.san !== undefined) {
    const move = legalMove(edit.epd, { uci: edit.uci, san: edit.san });
    if (!move || (edit.uci !== undefined && edit.san !== undefined && legalMove(edit.epd, { san: edit.san })?.uci !== move.uci)) {
      throw new RepertoireInputError(400, `${edit.san ?? edit.uci} is not a legal move in ${edit.epd}.`);
    }
    if (current && current.uci === move.uci) {
      entry = { ...current };
    } else {
      const ply = current?.ply ?? edit.ply;
      if (ply === undefined) {
        throw new RepertoireInputError(400, "A new entry needs its ply (the move's number on the path from the start).");
      }
      entry = {
        color: edit.color,
        epd: edit.epd,
        uci: move.uci,
        san: move.san,
        source: "edited",
        status: "active",
        locked: true,
        replaced: replacedBy(edit, current, move.uci),
        reason: null,
        note: current?.note ?? null,
        ply,
        updatedAt: now
      };
    }
  } else if (current) {
    entry = { ...current };
  } else {
    throw new RepertoireInputError(404, `No ${edit.color} entry at ${edit.epd}; pass a move to create one.`);
  }
  if (edit.locked !== undefined) {
    entry.locked = edit.locked;
  }
  if (edit.status !== undefined) {
    entry.status = edit.status;
  }
  if (edit.note !== undefined) {
    entry.note = edit.note && edit.note.trim() ? edit.note.trim() : null;
  }
  const changed = !current || JSON.stringify({ ...current, updatedAt: 0 }) !== JSON.stringify({ ...entry, updatedAt: 0 });
  if (changed) {
    entry.updatedAt = now;
    upsertRepEntry(db, owner, entry);
  }
  return entry;
}

/** A colour's repertoire lines as PGN with variations (the main line follows the most common reply). */
export function repertoirePgn(view: ColorRepertoireView, owner: string, date: Date): string {
  const byEpd = new Map(view.nodes.map((node) => [node.epd, node]));
  const emitted = new Set<string>();
  const moveText = (ply: number, san: string, number: boolean) => {
    const move = Math.ceil(ply / 2);
    return ply % 2 === 1 ? `${move}. ${san}` : number ? `${move}... ${san}` : san;
  };
  const comment = (node: RepNodeView | undefined): string[] => {
    const entry = node?.entry;
    if (!entry) {
      return [];
    }
    const tags = [
      entry.source === "edited" ? "edited" : entry.replaced ? `suggested, replaces ${entry.replaced.san}` : entry.source === "seed-engine" ? "suggested" : "",
      entry.status === "needs-review" ? "needs review" : ""
    ].filter(Boolean);
    return tags.length ? [`{${tags.join("; ")}}`] : [];
  };
  // Tokens for the continuation from `epd`, whose next move is ply `ply`.
  const line = (epd: string, ply: number, numberFirst: boolean): string[] => {
    const node = byEpd.get(epd);
    if (!node || emitted.has(epd) || !node.children.length) {
      return [];
    }
    emitted.add(epd);
    const [main, ...alternatives] = node.children;
    const tokens = [moveText(ply, main.san, numberFirst), ...comment(node)];
    for (const alternative of alternatives) {
      tokens.push("(", moveText(ply, alternative.san, true), ...line(alternative.toEpd, ply + 1, false), ")");
    }
    tokens.push(...line(main.toEpd, ply + 1, alternatives.length > 0 || comment(node).length > 0));
    return tokens;
  };
  const side = view.color === "white" ? "White" : "Black";
  const headers = [
    `[Event "${owner} repertoire as ${side}"]`,
    `[Site "chess-analyzer"]`,
    `[Date "${date.toISOString().slice(0, 10).replaceAll("-", ".")}"]`,
    `[White "${view.color === "white" ? owner : "?"}"]`,
    `[Black "${view.color === "black" ? owner : "?"}"]`,
    `[Result "*"]`
  ];
  const text = [...line(START_EPD, 1, true), "*"].join(" ").replaceAll("( ", "(").replaceAll(" )", ")");
  // Wrap at 80 columns (a comment may span lines in PGN).
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current && current.length + word.length + 1 > 80) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  lines.push(current);
  return `${headers.join("\n")}\n\n${lines.join("\n")}\n`;
}

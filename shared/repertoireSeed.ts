import { START_EPD } from "./epd.js";
import type { ResultsLeakItem } from "./fixList.js";
import { rootVerdict, round2, sanOf, type EvalLookup } from "./openingAnalysis.js";
import type { OpeningTree, TreeEdge, TreeNode } from "./openingTree.js";
import { REPERTOIRE_MAX_PLY, legalMove, type ColorRepertoire, type RepEntry, type RepReplaced, type RepSource, type RepStatus } from "./repertoire.js";
import { scoreWinPercent } from "./eval.js";
import type { PlayerColor } from "./types.js";

// Deterministic repertoire seeding from the owner's own games. Per colour, a breadth-first walk
// from the start position to REPERTOIRE_MAX_PLY. At each owner-to-move position reached by at
// least SEED_MIN_N games, one move is chosen:
//
// 1. The owner's most-played move (recency-weighted n, then Δ per game, then engine loss, then
//    UCI), if the engine accepts it (loss < SEED_SOUND_LOSS win%). A move the cache has not scored
//    is accepted on results alone and marked needs-review.
// 2. Engine hole: when the most-played move loses SEED_SOUND_LOSS or more, the best engine-sound
//    move the owner has also played replaces it, else the engine's best move (seed-engine,
//    needs-review, `replaced` = the owner's move).
// 3. Consolidation: an accepted sibling that scores better against expectation with
//    z = ΔΔ / sqrt(0.24/n_s + 0.24/n_c) >= 1.64 (both on the effective n, the sibling with at
//    least SEED_CONSOLIDATE_MIN_N games) is chosen instead, marked needs-review. When the owner also
//    plays a sibling in at least half as many games (1...e5 next to 1...d5 against 1.e4), the
//    choice is kept but marked needs-review with `replaced` = that sibling.
// 4. Results-leak override (the P7 critic): when the chosen move is a flagged results leak or a
//    watch-tier line with at least SEED_FLAG_MIN_N games (e.g. the Albin 2...e5, which the engine
//    accepts), an engine-sound sibling replaces it (seed-engine, needs-review, `replaced` = the
//    flagged move with the results evidence).
//
// At opponent-to-move positions the walk follows replies with at least SEED_REPLY_MIN_N games or
// a weighted share of SEED_REPLY_MIN_SHARE. Locked and edited entries are never changed: the walk
// keeps them and follows their move. Same input, same output (every sort has a total order).

export const SEED_MIN_N = 3;
export const SEED_SOUND_LOSS = 5;
/** A most-played move losing this much is reported as an engine hole (between SOUND and HOLE: an inaccuracy). */
export const SEED_HOLE_LOSS = 7;
export const SEED_CONSOLIDATE_Z = 1.64;
export const SEED_CONSOLIDATE_MIN_N = 8;
/** A sibling played in at least this share of the chosen move's games makes the choice a consolidation. */
export const SEED_RIVAL_SHARE = 0.5;
export const SEED_FLAG_MIN_N = 15;
export const SEED_REPLY_MIN_N = 2;
export const SEED_REPLY_MIN_SHARE = 0.05;

/** A results flag on one owner edge, from the fix list (leak or watch tier). */
export interface SeedFlag {
  tier: "leak" | "watch";
  n: number;
  score: number;
  expected: number;
  z: number;
  line: string;
}

export interface SeedInput {
  tree: OpeningTree;
  /** The position cache, or null without an engine. */
  lookup: EvalLookup | null;
  /** Results flags keyed by `${epd}|${uci}`. */
  flags: ReadonlyMap<string, SeedFlag>;
  /** This colour's current entries: locked and edited ones are kept and followed. */
  existing: ColorRepertoire;
  maxPly?: number;
}

/** A seeded (or kept) entry, without timestamps. */
export interface SeedEntry {
  color: PlayerColor;
  epd: string;
  ply: number;
  uci: string;
  san: string;
  source: RepSource;
  status: RepStatus;
  replaced: RepReplaced | null;
  reason: string | null;
  /** A locked or edited entry the seed kept as it was. */
  kept: boolean;
}

export function isProtected(entry: Pick<RepEntry, "locked" | "source">): boolean {
  return entry.locked || entry.source === "edited";
}

interface Candidate {
  uci: string;
  san: string;
  edge: TreeEdge | null;
  /** Win% loss at the root, or null when the cache has not scored it. */
  loss: number | null;
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const signedPct = (value: number) => `${value >= 0 ? "+" : "−"}${Math.abs(Math.round(value * 100))}%`;
const games = (n: number) => `${n} game${n === 1 ? "" : "s"}`;

function byPlay(a: Candidate, b: Candidate): number {
  const wa = a.edge?.weighted.wN ?? 0;
  const wb = b.edge?.weighted.wN ?? 0;
  if (wa !== wb) {
    return wb - wa;
  }
  const da = a.edge?.weighted.delta ?? 0;
  const db = b.edge?.weighted.delta ?? 0;
  if (da !== db) {
    return db - da;
  }
  const la = a.loss ?? Number.POSITIVE_INFINITY;
  const lb = b.loss ?? Number.POSITIVE_INFINITY;
  if (la !== lb) {
    return la - lb;
  }
  return a.uci < b.uci ? -1 : a.uci > b.uci ? 1 : 0;
}

const isSound = (candidate: Candidate) => candidate.loss !== null && candidate.loss < SEED_SOUND_LOSS;

/** z of `sibling` scoring better than `chosen` against expectation (per game, on the effective n). */
export function consolidationZ(sibling: TreeEdge, chosen: TreeEdge): number {
  const variance = 0.24 / sibling.weighted.ess + 0.24 / chosen.weighted.ess;
  return variance > 0 && Number.isFinite(variance) ? (sibling.weighted.delta - chosen.weighted.delta) / Math.sqrt(variance) : 0;
}

function describe(candidate: Candidate): string {
  const edge = candidate.edge;
  const record = edge ? `${games(edge.n)}, ${pct(edge.raw.score)}` : "not played by you";
  const engine = candidate.loss === null ? "no engine data" : `engine loss ${candidate.loss.toFixed(1)}`;
  return `${candidate.san} (${record}; ${engine})`;
}

function flagReason(flag: SeedFlag): string {
  return (
    `${flag.tier === "leak" ? "Results leak" : "Watch-tier results"}: you score ${pct(flag.score)} over ${games(flag.n)} ` +
    `(expected ${pct(flag.expected)}, z ${flag.z.toFixed(2)}).`
  );
}

interface Choice {
  pick: Candidate;
  source: RepSource;
  status: RepStatus;
  replaced: RepReplaced | null;
  reason: string;
}

function chooseMove(node: TreeNode, input: SeedInput): Choice | null {
  const evaluation = input.lookup?.(node.epd, "owner");
  const flagOf = (uci: string) => {
    const flag = input.flags.get(`${node.epd}|${uci}`);
    return flag && flag.n >= SEED_FLAG_MIN_N ? flag : undefined;
  };
  const owned: Candidate[] = node.edges
    .filter((edge) => edge.owner)
    .map((edge) => {
      const verdict = rootVerdict(evaluation, edge.uci);
      return { uci: edge.uci, san: edge.san, edge, loss: verdict ? round2(verdict.loss) : null };
    })
    .sort(byPlay);
  if (!owned.length) {
    return null;
  }

  // The engine's own lines at this root, for moves the owner has not played.
  const best = evaluation?.lines[0];
  const engineMoves: Candidate[] = best
    ? evaluation.lines
        .filter((line) => !owned.some((candidate) => candidate.uci === line.uci))
        .map((line) => ({
          uci: line.uci,
          san: sanOf(node.epd, line.uci),
          edge: null,
          loss: round2(Math.max(0, scoreWinPercent(best) - scoreWinPercent(line)))
        }))
        .sort((a, b) => a.loss! - b.loss! || (a.uci < b.uci ? -1 : 1))
    : [];

  /** An engine-sound replacement for `excluded`: a move the owner plays, else the engine's. */
  const replacement = (excluded: string): Candidate | undefined =>
    owned.find((candidate) => candidate.uci !== excluded && isSound(candidate) && !flagOf(candidate.uci)) ??
    engineMoves.find((candidate) => candidate.uci !== excluded && isSound(candidate));

  const top = owned[0];
  let choice: Choice;
  if (top.loss !== null && !isSound(top)) {
    // 2. Engine hole (or an inaccuracy): the owner's most-played move is not engine-sound.
    const pick = replacement(top.uci);
    const kind = top.loss >= SEED_HOLE_LOSS ? "engine hole" : "inaccuracy";
    choice = !pick
      ? { pick: top, source: "from-games", status: "needs-review", replaced: null, reason: `Your most played move: ${describe(top)}; no engine-sound alternative is known yet.` }
      : {
      pick,
      source: "seed-engine",
      status: "needs-review",
      replaced: { uci: top.uci, san: top.san, loss: top.loss, reason: `${top.san} loses ${top.loss.toFixed(1)} win% (${kind}).` },
      reason: pick.edge
        ? `Engine-sound move you also play: ${describe(pick)}.`
        : `The engine's move here: ${describe(pick)}; you have not played it.`
    };
  } else if (top.loss === null) {
    choice = { pick: top, source: "from-games", status: "needs-review", replaced: null, reason: `Your most played move: ${describe(top)}; chosen on results only until the engine checks it.` };
  } else {
    choice = { pick: top, source: "from-games", status: "active", replaced: null, reason: `Your most played move: ${describe(top)}.` };
  }

  // 3. Consolidation onto a sibling that scores clearly better.
  if (choice.pick === top) {
    let better: { candidate: Candidate; z: number } | null = null;
    for (const candidate of owned) {
      if (candidate === top || !(candidate.loss === null || isSound(candidate)) || candidate.edge!.n < SEED_CONSOLIDATE_MIN_N) {
        continue;
      }
      const z = consolidationZ(candidate.edge!, top.edge!);
      if (z >= SEED_CONSOLIDATE_Z && (!better || z > better.z)) {
        better = { candidate, z };
      }
    }
    if (better) {
      const sibling = better.candidate.edge!;
      const chosen = top.edge!;
      choice = {
        pick: better.candidate,
        source: "from-games",
        status: "needs-review",
        replaced: {
          uci: top.uci,
          san: top.san,
          loss: top.loss,
          reason:
            `You score ${signedPct(sibling.weighted.delta)} against expectation with ${better.candidate.san} (${games(sibling.n)}) ` +
            `and ${signedPct(chosen.weighted.delta)} with ${top.san} (${games(chosen.n)}), z ${better.z.toFixed(2)}.`
        },
        reason: `Consolidation on your better-scoring move: ${describe(better.candidate)}.`
      };
    }
  }

  // 3b. A close rival: the owner also plays a sibling in at least SEED_RIVAL_SHARE of the chosen
  // move's games (e.g. 1...e5 next to 1...d5 against 1.e4). Picking one is a consolidation, so it
  // stays visible for review, with the rival as the replaced move.
  if (choice.pick === top && !choice.replaced) {
    const rival = owned
      .filter((candidate) => candidate !== top && (candidate.loss === null || isSound(candidate)))
      .filter((candidate) => candidate.edge!.n >= SEED_CONSOLIDATE_MIN_N && candidate.edge!.n >= SEED_RIVAL_SHARE * top.edge!.n)
      .sort((a, b) => b.edge!.n - a.edge!.n || byPlay(a, b))[0];
    if (rival) {
      const z = consolidationZ(top.edge!, rival.edge!);
      choice = {
        ...choice,
        status: "needs-review",
        replaced: {
          uci: rival.uci,
          san: rival.san,
          loss: rival.loss,
          reason:
            `You play both: ${top.san} in ${games(top.edge!.n)} (weighted ${top.edge!.weighted.wN.toFixed(0)}), ${rival.san} in ` +
            `${games(rival.edge!.n)} (weighted ${rival.edge!.weighted.wN.toFixed(0)}). Against expectation ${top.san} scores ` +
            `${signedPct(top.edge!.weighted.delta)} and ${rival.san} ${signedPct(rival.edge!.weighted.delta)} (z ${z.toFixed(2)}).`
        },
        reason: `Consolidation on your most played move: ${describe(top)}.`
      };
    }
  }

  // 4. The results-leak override.
  const flag = choice.pick.edge ? flagOf(choice.pick.uci) : undefined;
  if (flag) {
    const pick = replacement(choice.pick.uci);
    if (pick) {
      choice = {
        pick,
        source: "seed-engine",
        status: "needs-review",
        replaced: { uci: choice.pick.uci, san: choice.pick.san, loss: choice.pick.loss, reason: flagReason(flag) },
        reason: pick.edge
          ? `Engine-sound move you also play: ${describe(pick)}.`
          : `Engine-sound alternative: ${describe(pick)}; you have not played it.`
      };
    } else {
      choice = { ...choice, status: "needs-review", reason: `${choice.reason} ${flagReason(flag)} No engine-sound alternative is known yet.` };
    }
  }
  return choice;
}

/** The seed of one colour: every entry the walk reaches, locked and edited ones kept, sorted by ply then EPD. */
export function seedColor(input: SeedInput): SeedEntry[] {
  const { tree } = input;
  const color = tree.color;
  const maxPly = input.maxPly ?? REPERTOIRE_MAX_PLY;
  const entries: SeedEntry[] = [];
  const seen = new Set<string>([START_EPD]);
  const queue: { epd: string; ply: number }[] = [{ epd: START_EPD, ply: 0 }];
  const visit = (epd: string, ply: number) => {
    if (!seen.has(epd)) {
      seen.add(epd);
      queue.push({ epd, ply });
    }
  };

  for (let index = 0; index < queue.length; index += 1) {
    const { epd, ply } = queue[index];
    const node = tree.nodes.get(epd);
    const ownerToMove = (epd.split(" ")[1] === "w") === (color === "white");
    if (ownerToMove) {
      if (ply >= maxPly) {
        continue;
      }
      const existing = input.existing.get(epd);
      if (existing && isProtected(existing)) {
        entries.push({
          color,
          epd,
          ply: ply + 1,
          uci: existing.uci,
          san: existing.san,
          source: existing.source,
          status: existing.status,
          replaced: existing.replaced,
          reason: existing.reason,
          kept: true
        });
        const next = legalMove(epd, { uci: existing.uci });
        if (next) {
          visit(next.toEpd, ply + 1);
        }
        continue;
      }
      if (!node || node.n < SEED_MIN_N) {
        continue;
      }
      const choice = chooseMove(node, input);
      if (!choice) {
        continue;
      }
      entries.push({
        color,
        epd,
        ply: ply + 1,
        uci: choice.pick.uci,
        san: choice.pick.san,
        source: choice.source,
        status: choice.status,
        replaced: choice.replaced,
        reason: choice.reason,
        kept: false
      });
      const toEpd = choice.pick.edge?.toEpd ?? legalMove(epd, { uci: choice.pick.uci })?.toEpd;
      if (toEpd) {
        visit(toEpd, ply + 1);
      }
      continue;
    }
    if (!node || ply + 1 >= maxPly) {
      continue;
    }
    for (const edge of node.edges) {
      const share = node.wN > 0 ? edge.weighted.wN / node.wN : 0;
      if (edge.n >= SEED_REPLY_MIN_N || share >= SEED_REPLY_MIN_SHARE) {
        visit(edge.toEpd, ply + 1);
      }
    }
  }

  // Locked or edited entries the walk no longer reaches are kept too.
  const reached = new Set(entries.map((entry) => entry.epd));
  for (const existing of input.existing.values()) {
    if (isProtected(existing) && !reached.has(existing.epd)) {
      entries.push({ ...pickSeedFields(existing), kept: true });
    }
  }
  return entries.sort((a, b) => a.ply - b.ply || (a.epd < b.epd ? -1 : a.epd > b.epd ? 1 : 0));
}

function pickSeedFields(entry: RepEntry): Omit<SeedEntry, "kept"> {
  const { color, epd, ply, uci, san, source, status, replaced, reason } = entry;
  return { color, epd, ply, uci, san, source, status, replaced, reason };
}

export type SeedChangeKind = "add" | "change" | "update" | "remove";

export interface SeedChange {
  kind: SeedChangeKind;
  color: PlayerColor;
  epd: string;
  ply: number;
  /** The current entry (change, update, remove). */
  before: Omit<SeedEntry, "kept"> | null;
  /** The seeded entry (add, change, update). */
  after: Omit<SeedEntry, "kept"> | null;
}

export interface SeedDiff {
  changes: SeedChange[];
  /** Locked or edited entries left as they are. */
  kept: number;
  /** Seeded entries identical to the current ones. */
  unchanged: number;
}

const sameReplaced = (a: RepReplaced | null, b: RepReplaced | null) => JSON.stringify(a) === JSON.stringify(b);

/** What applying `seeded` would do to `existing` (one colour). Protected entries never change. */
export function seedDiff(existing: ColorRepertoire, seeded: readonly SeedEntry[]): SeedDiff {
  const changes: SeedChange[] = [];
  let kept = 0;
  let unchanged = 0;
  const seededEpds = new Set<string>();
  for (const entry of seeded) {
    seededEpds.add(entry.epd);
    const { kept: isKept, ...after } = entry;
    if (isKept) {
      kept += 1;
      continue;
    }
    const current = existing.get(entry.epd);
    if (!current) {
      changes.push({ kind: "add", color: entry.color, epd: entry.epd, ply: entry.ply, before: null, after });
      continue;
    }
    const before = pickSeedFields(current);
    if (current.uci !== entry.uci) {
      changes.push({ kind: "change", color: entry.color, epd: entry.epd, ply: entry.ply, before, after });
    } else if (
      current.source !== entry.source ||
      current.status !== entry.status ||
      current.reason !== entry.reason ||
      current.ply !== entry.ply ||
      !sameReplaced(current.replaced, entry.replaced)
    ) {
      changes.push({ kind: "update", color: entry.color, epd: entry.epd, ply: entry.ply, before, after });
    } else {
      unchanged += 1;
    }
  }
  for (const current of existing.values()) {
    if (!seededEpds.has(current.epd) && !isProtected(current)) {
      changes.push({ kind: "remove", color: current.color, epd: current.epd, ply: current.ply, before: pickSeedFields(current), after: null });
    }
  }
  const order: Record<SeedChangeKind, number> = { change: 0, add: 1, remove: 2, update: 3 };
  changes.sort((a, b) => order[a.kind] - order[b.kind] || a.ply - b.ply || (a.epd < b.epd ? -1 : a.epd > b.epd ? 1 : 0));
  return { changes, kept, unchanged };
}

/**
 * The fix list's results flags (leak and watch items) of one colour, keyed by the position the
 * flagged move is played from and the move.
 */
export function seedFlags(items: readonly ResultsLeakItem[], color: PlayerColor): Map<string, SeedFlag> {
  const flags = new Map<string, SeedFlag>();
  for (const item of items) {
    if (item.color !== color || !item.moves.length) {
      continue;
    }
    let epd = START_EPD;
    let ok = true;
    for (const uci of item.moves.slice(0, -1)) {
      const next = legalMove(epd, { uci });
      if (!next) {
        ok = false;
        break;
      }
      epd = next.toEpd;
    }
    if (!ok) {
      continue;
    }
    const key = `${epd}|${item.moves[item.moves.length - 1]}`;
    const flag: SeedFlag = { tier: item.tier, n: item.n, score: item.score, expected: item.expected, z: item.z, line: item.line };
    const current = flags.get(key);
    // A leak outranks a watch line on the same edge (transposed move orders).
    if (!current || (current.tier === "watch" && flag.tier === "leak")) {
      flags.set(key, flag);
    }
  }
  return flags;
}

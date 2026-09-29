import { scoreWinPercent, toWhiteEval } from "./eval.js";
import { bookChildren, type OpeningBook } from "./openingBook.js";
import { round2, type EvalLookup } from "./openingAnalysis.js";
import { formatLine, principalPaths, type OpeningTree, type TreeEdge, type TreeGame, type TreeNode, type TreePath } from "./openingTree.js";
import { legalMove, type ColorRepertoire } from "./repertoire.js";
import type { SeedFlag } from "./repertoireSeed.js";
import { LOW_SAMPLE_N, ageDays, eloExpected, recencyWeight } from "./stats.js";
import { gamesThrough } from "./treeEngine.js";
import { START_EPD } from "./epd.js";
import type { EngineLine, JobState, PlayerColor, PositionEval } from "./types.js";

// Offline alternatives at one owner-to-move position: which moves could replace the owner's move
// there, ranked by how well they fit his play. Pure and deterministic (every sort has a total
// order); the server supplies the root's engine eval (the lazy deep tier when it is ready, else
// the owner-tier cache row) and the cached evals along each candidate's sample line.
//
// Candidates are the engine's lines at the root, the book's children (the most-travelled
// ALT_BOOK_MAX, by the book's line count) and the owner's own moves with ALT_OWNED_MIN_N games.
// The gate is the engine alone: a candidate must be scored at the root and lose at most
// ALT_GATE_LOSS win% against the best line, from the owner's side. Being a book move never passes
// the gate by itself. A gated move that is neither a book move nor one the owner plays is listed
// last and labelled an "engine idea" (the critic: the engine's top moves include impractical ones).
//
// Ranking features, each a signed number of points with a reason built only from measured facts:
// - owned: +4 with ALT_OWNED_MIN_N games at a (recency-weighted) score of 50% or more, +2 with any game;
// - named: +3 when the position the move reaches is named in the book, +1 when it is only on a line;
// - mainstream (the critic's popularity stand-in): +2 when ALT_MAINSTREAM_HIGH of the book's lines
//   from here continue with the move, +1 from ALT_MAINSTREAM_LOW;
// - results: +2 when the owner plays it in ALT_RESULTS_MIN_N games and it scores better against his
//   Elo expectation than the questioned move with z >= ALT_RESULTS_Z;
// - familiar: +2 when the pawns after the move and up to 4 plies of its line match (Jaccard >=
//   ALT_FAMILIAR_JACCARD) a position the owner reaches in ALT_FAMILIAR_MIN_WN weighted games;
// - transposes: +2 when a move he has not played reaches, within 6 plies, a position of his tree;
// - simplicity: -1 per only-move the owner faces on the sample line (the second-best move at least
//   ALT_ONLY_MOVE_GAP win% worse, from the cached owner-tier rows), -1 when at least
//   ALT_FORCING_PLIES of the 6 plies are checks or captures; together at most ALT_SIMPLICITY_CAP;
// - eval gap (the soundness margin): -1 per win% below the best line.

export const ALT_GATE_LOSS = 5;
export const ALT_BOOK_MAX = 6;
export const ALT_OWNED_MIN_N = 3;
export const ALT_TOP = 3;
export const ALT_SAMPLE_PLIES = 6;
export const ALT_MAINSTREAM_HIGH = 0.25;
export const ALT_MAINSTREAM_LOW = 0.08;
export const ALT_FAMILIAR_JACCARD = 0.85;
export const ALT_FAMILIAR_MIN_WN = 3;
/** Plies of the sample line (after the move) that the familiar feature compares. */
export const ALT_FAMILIAR_PLIES = 4;
export const ALT_TRANSPOSE_MIN_N = 3;
export const ALT_ONLY_MOVE_GAP = 10;
export const ALT_FORCING_PLIES = 3;
export const ALT_SIMPLICITY_CAP = -3;
export const ALT_RESULTS_MIN_N = 20;
export const ALT_RESULTS_Z = 1.64;
/** A results flag counts for "change earlier" from this many games (the seed's SEED_FLAG_MIN_N). */
export const ALT_FLAG_MIN_N = 15;
/** A move losing this much at the root is an engine hole (as the seed and the fix list). */
export const ALT_HOLE_LOSS = 5;
/** Typical replies shown per alternative. */
export const ALT_REPLIES = 4;
/** "Where the points are lost": reply rows and owner answers per row. */
export const ALT_LOST_ROWS = 6;
export const ALT_LOST_ANSWERS = 3;

export type AltFeature = "owned" | "named" | "mainstream" | "results" | "familiar" | "transposes" | "only-moves" | "forcing" | "eval-gap";

export interface AltReason {
  feature: AltFeature;
  points: number;
  text: string;
}

export interface AltReply {
  uci: string;
  san: string;
  /** games: the owner's opponents played it; book: a book move; engine: the sample line's reply. */
  source: "games" | "book" | "engine";
  /** Games of the owner's in which the opponent played it (0 when none). */
  n: number;
  name: string | null;
}

export interface AltOwnerStats {
  n: number;
  /** Raw score, 0..1, with its 95% Wilson interval. */
  score: number;
  ci: [number, number];
  /** Recency-weighted score and Δ against the Elo expectation. */
  weightedScore: number;
  delta: number;
  lowSample: boolean;
}

export interface AltEval {
  /** Owner's win% after the move (the root line's score). */
  winPct: number;
  /** Win% below the best line at the root (0 for the best). */
  gap: number;
  /** White-view eval after the move (cp clamped, mate as M#). */
  white: { cp: number; mate: number | null };
}

export interface Alternative {
  uci: string;
  san: string;
  /** owned: the owner has played it; book: a book move he has not played; engine-idea: neither. */
  kind: "owned" | "book" | "engine-idea";
  eval: AltEval;
  /** The book name of the position the move reaches (the deepest name on its line when not exact). */
  name: string | null;
  eco: string | null;
  nameExact: boolean;
  ownerStats: AltOwnerStats | null;
  /** Up to ALT_SAMPLE_PLIES plies from the root, starting with the move (the engine's line). */
  sampleLine: { ucis: string[]; sans: string[] };
  replies: AltReply[];
  reasons: AltReason[];
  /** The sum of the reasons' points. */
  score: number;
  /** Owner positions on the sample line and how many were checked for only-moves / are only-moves. */
  onlyMoves: { positions: number; checked: number; found: number };
  /** The repertoire's move here. */
  isRepertoire: boolean;
}

export interface AltCurrent {
  uci: string;
  san: string;
  /** Why this move is the one questioned. */
  source: "asked" | "repertoire" | "most-played";
  eval: AltEval | null;
  /** loss >= ALT_HOLE_LOSS at the root. */
  hole: boolean;
  /** The fix list's results flag on the move, if any. */
  flag: SeedFlag | null;
  ownerStats: AltOwnerStats | null;
  name: string | null;
  isRepertoire: boolean;
}

export interface AltRejected {
  uci: string;
  san: string;
  /** Null when the engine has not scored it. */
  gap: number | null;
  reason: string;
}

export interface PointsLostAnswer {
  uci: string;
  san: string;
  n: number;
  score: number;
  /** Recency-weighted points below the Elo expectation (negative: points gained). */
  pointsLost: number;
}

export interface PointsLostRow extends PointsLostAnswer {
  /** The owner's next moves after this reply. */
  answers: PointsLostAnswer[];
}

/** Where the questioned move's points go: its games split by the opponent's reply and the owner's answer. */
export interface PointsLost {
  uci: string;
  san: string;
  n: number;
  score: number;
  pointsLost: number;
  rows: PointsLostRow[];
  /** Games in the replies not shown. */
  otherN: number;
  otherPointsLost: number;
}

export interface AncestorMove {
  uci: string;
  san: string;
  n: number;
  score: number | null;
  /** Win% below the ancestor's best line, when cached. */
  gap: number | null;
  name: string | null;
}

/** "Change earlier": another owner move at an earlier position of the line. */
export interface AncestorSuggestion {
  /** results: a sibling scores clearly better; leak: the move on the path is a flagged results leak. */
  kind: "results" | "leak";
  epd: string;
  /** The ply of the owner's move there (1-based). */
  ply: number;
  /** UCI and SAN moves from the start to the ancestor position. */
  moves: string[];
  sans: string[];
  /** The move the line plays there. */
  instead: AncestorMove;
  /** Suggested moves, best first. */
  play: AncestorMove[];
  reason: string;
}

export interface AltEngineInfo {
  tier: "deep" | "owner";
  depth: number;
  nodes: number;
  multipv: number;
  bestUci: string;
  bestSan: string;
}

export interface AlternativesResult {
  color: PlayerColor;
  epd: string;
  /** The ply of the owner's move here (1-based). */
  ply: number;
  moves: string[];
  sans: string[];
  name: string | null;
  eco: string | null;
  /** Games of the owner's that reached the position. */
  n: number;
  gate: number;
  engine: AltEngineInfo | null;
  current: AltCurrent | null;
  /** The top ALT_TOP gated candidates (the questioned move excluded). */
  alternatives: Alternative[];
  /** The other gated candidates, engine ideas last. */
  others: Alternative[];
  rejected: AltRejected[];
  pointsLost: PointsLost | null;
  ancestors: AncestorSuggestion[];
  honesty: string[];
}

/** What one open of the panel cost the engine (the per-open cost of the deep tier). */
export interface AltCost {
  ms: number;
  /** Nodes searched now: the deep root with its follow-ups, and the only-move positions. */
  nodes: { deep: number; onlyMoves: number };
  /** Positions searched now (the deep root counts once). */
  searched: number;
}

/** GET /api/alternatives. */
export interface AlternativesResponse {
  /**
   * complete: ranked on the deep row with every only-move check done; preliminary: ranked on the
   * owner-tier cache while `job` runs the deep search (its result is the complete response);
   * no-engine: Stockfish is not available, so nothing passes the gate.
   */
  status: "complete" | "preliminary" | "no-engine";
  result: AlternativesResult;
  job: JobState<AlternativesResponse> | null;
  engineError: string | null;
  /** Set on the job's result: what the engine searched for this open. */
  cost: AltCost | null;
}

export interface AltInput {
  tree: OpeningTree;
  /** The games the tree was built from (for "where the points are lost"). */
  games: readonly TreeGame[];
  book: OpeningBook;
  /** The owner-to-move position and the moves that reach it. */
  epd: string;
  path: TreePath;
  /** The root's eval: the deep tier when present, else the owner tier; undefined without engine data. */
  root: PositionEval | undefined;
  /** The position cache (owner and opponent tiers), for only-moves and the ancestors; null without an engine. */
  lookup: EvalLookup | null;
  /** The ancestors' root evals, if the caller has better ones than `lookup` (e.g. deep rows). */
  ancestorRoot?: (epd: string) => PositionEval | undefined;
  /** The move to question (from the Explorer row or a fix card); default the repertoire's, else the most played. */
  current?: string | null;
  /** The fix list's results flags, keyed `${epd}|${uci}`. */
  flags: ReadonlyMap<string, SeedFlag>;
  entries: ColorRepertoire;
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const signedPct = (value: number) => `${value >= 0 ? "+" : "−"}${Math.abs(Math.round(value * 100))}%`;
const games = (n: number) => `${n} game${n === 1 ? "" : "s"}`;
const byUci = (a: { uci: string }, b: { uci: string }) => (a.uci < b.uci ? -1 : a.uci > b.uci ? 1 : 0);

function lineFor(evaluation: PositionEval | undefined, uci: string): EngineLine | undefined {
  return evaluation?.lines.find((line) => line.uci === uci) ?? evaluation?.scored.find((line) => line.uci === uci);
}

/** The side to move of an EPD. */
function mover(epd: string): PlayerColor {
  return epd.split(" ")[1] === "b" ? "black" : "white";
}

function evalOf(root: PositionEval | undefined, uci: string, color: PlayerColor): AltEval | null {
  const best = root?.lines[0];
  const line = lineFor(root, uci);
  if (!best || !line) {
    return null;
  }
  const white = toWhiteEval(line, color);
  return {
    winPct: round2(scoreWinPercent(line)),
    gap: round2(Math.max(0, scoreWinPercent(best) - scoreWinPercent(line))),
    white: { cp: white.cp, mate: white.mate }
  };
}

function ownerStatsOf(edge: TreeEdge | undefined): AltOwnerStats | null {
  if (!edge || !edge.owner || edge.n < 1) {
    return null;
  }
  return {
    n: edge.n,
    score: edge.raw.score,
    ci: edge.raw.ci,
    weightedScore: edge.weighted.score,
    delta: edge.weighted.delta,
    lowSample: edge.n < LOW_SAMPLE_N
  };
}

/** z of `sibling` scoring better than `chosen` against expectation, per game on the effective n (the seed's consolidation z). */
export function siblingZ(sibling: TreeEdge, chosen: TreeEdge): number {
  const variance = 0.24 / sibling.weighted.ess + 0.24 / chosen.weighted.ess;
  return variance > 0 && Number.isFinite(variance) ? (sibling.weighted.delta - chosen.weighted.delta) / Math.sqrt(variance) : 0;
}

/**
 * The moves to score at the root: the engine's lines, the most-travelled book children, the
 * owner's moves with ALT_OWNED_MIN_N games and the questioned move. Sorted by UCI (a stable
 * `played` list for the deep search).
 */
export function alternativeCandidates(node: TreeNode | undefined, epd: string, book: OpeningBook, root: PositionEval | undefined, current?: string | null): string[] {
  const ucis = new Set<string>();
  for (const line of root?.lines ?? []) {
    ucis.add(line.uci);
  }
  for (const child of mainstreamChildren(book, epd).slice(0, ALT_BOOK_MAX)) {
    ucis.add(child.uci);
  }
  for (const edge of node?.edges ?? []) {
    if (edge.owner && edge.n >= ALT_OWNED_MIN_N) {
      ucis.add(edge.uci);
    }
  }
  if (current) {
    ucis.add(current);
  }
  return [...ucis].filter((uci) => legalMove(epd, { uci })).sort();
}

/** The book's children of `epd` with their line counts, most-travelled first (ties by UCI). */
function mainstreamChildren(book: OpeningBook, epd: string): { uci: string; san: string; toEpd: string; lines: number }[] {
  return bookChildren(book, epd)
    .map((child) => ({ ...child, lines: book.lineCount.get(child.toEpd) ?? 0 }))
    .sort((a, b) => b.lines - a.lines || byUci(a, b));
}

/** The sample line of a candidate: its PV at the root, as far as it is legal, capped at ALT_SAMPLE_PLIES. */
function sampleLineOf(root: PositionEval | undefined, epd: string, uci: string): { ucis: string[]; sans: string[]; epds: string[] } {
  const pv = lineFor(root, uci)?.pv ?? [uci];
  const ucis: string[] = [];
  const sans: string[] = [];
  const epds: string[] = [];
  let at = epd;
  for (const move of (pv[0] === uci ? pv : [uci]).slice(0, ALT_SAMPLE_PLIES)) {
    const next = legalMove(at, { uci: move });
    if (!next) {
      break;
    }
    ucis.push(next.uci);
    sans.push(next.san);
    epds.push(next.toEpd);
    at = next.toEpd;
  }
  return { ucis, sans, epds };
}

/**
 * The owner-to-move positions on a candidate's sample line (after its 2nd and 4th plies), with
 * the UCI moves from the start: the server scores them at the owner tier for the only-move check.
 */
export function onlyMovePositions(root: PositionEval | undefined, epd: string, path: readonly string[], uci: string): { epd: string; moves: string[] }[] {
  const line = sampleLineOf(root, epd, uci);
  const positions: { epd: string; moves: string[] }[] = [];
  for (let index = 1; index < line.epds.length - 1; index += 2) {
    positions.push({ epd: line.epds[index], moves: [...path, ...line.ucis.slice(0, index + 1)] });
  }
  return positions;
}

/** Pawns of an EPD as "Pe4"/"pd5" squares. */
export function pawnSet(epd: string): Set<string> {
  const pawns = new Set<string>();
  const rows = epd.split(" ")[0].split("/");
  rows.forEach((row, rank) => {
    let file = 0;
    for (const char of row) {
      if (/\d/.test(char)) {
        file += Number(char);
        continue;
      }
      if (char === "P" || char === "p") {
        pawns.add(`${char}${"abcdefgh"[file]}${8 - rank}`);
      }
      file += 1;
    }
  });
  return pawns;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let both = 0;
  for (const item of a) {
    if (b.has(item)) {
      both += 1;
    }
  }
  const union = a.size + b.size - both;
  return union ? both / union : 1;
}

interface TreeIndex {
  paths: Map<string, TreePath>;
  pawns: { node: TreeNode; pawns: Set<string> }[];
}

const treeIndexes = new WeakMap<OpeningTree, TreeIndex>();

function treeIndex(tree: OpeningTree): TreeIndex {
  let index = treeIndexes.get(tree);
  if (!index) {
    const pawns = [...tree.nodes.values()]
      .filter((node) => node.wN >= ALT_FAMILIAR_MIN_WN)
      .sort((a, b) => a.ply - b.ply || b.n - a.n || (a.epd < b.epd ? -1 : a.epd > b.epd ? 1 : 0))
      .map((node) => ({ node, pawns: pawnSet(node.epd) }));
    index = { paths: principalPaths(tree), pawns };
    treeIndexes.set(tree, index);
  }
  return index;
}

const startsWith = (line: readonly string[], prefix: readonly string[]) => prefix.length <= line.length && prefix.every((uci, index) => line[index] === uci);

function nodeLabel(index: TreeIndex, node: TreeNode): string {
  const sans = index.paths.get(node.epd)?.sans ?? [];
  return `${formatLine(sans)}${node.name ? ` (${node.name})` : ""}`;
}

/** Typical replies after a move: the owner's opponents' moves, the book's, and the engine's. */
function repliesAfter(input: AltInput, toEpd: string, engineReply: string | undefined): AltReply[] {
  const replies: AltReply[] = [];
  const add = (reply: AltReply) => {
    if (!replies.some((existing) => existing.uci === reply.uci)) {
      replies.push(reply);
    }
  };
  const node = input.tree.nodes.get(toEpd);
  const bookNames = (uci: string) => {
    const child = bookChildren(input.book, toEpd).find((candidate) => candidate.uci === uci);
    return child ? input.book.named.get(child.toEpd)?.name ?? null : null;
  };
  for (const edge of (node?.edges ?? []).filter((candidate) => candidate.n >= 2).slice(0, ALT_REPLIES)) {
    add({ uci: edge.uci, san: edge.san, source: "games", n: edge.n, name: edge.nameExact ? edge.name : bookNames(edge.uci) });
  }
  for (const child of mainstreamChildren(input.book, toEpd)) {
    if (replies.length >= ALT_REPLIES) {
      break;
    }
    add({ uci: child.uci, san: child.san, source: "book", n: node?.edges.find((edge) => edge.uci === child.uci)?.n ?? 0, name: input.book.named.get(child.toEpd)?.name ?? null });
  }
  if (engineReply && replies.length < ALT_REPLIES) {
    const move = legalMove(toEpd, { uci: engineReply });
    if (move) {
      add({ uci: move.uci, san: move.san, source: "engine", n: node?.edges.find((edge) => edge.uci === move.uci)?.n ?? 0, name: input.book.named.get(move.toEpd)?.name ?? null });
    }
  }
  return replies.slice(0, ALT_REPLIES);
}

interface Context {
  input: AltInput;
  color: PlayerColor;
  node: TreeNode | undefined;
  index: TreeIndex;
  bookLines: number;
  current: { uci: string; edge: TreeEdge | undefined } | null;
  /** Nodes to leave out of the familiar comparison: the root's path, and the subtrees of the questioned move. */
  excluded: (node: TreeNode) => boolean;
}

function buildAlternative(context: Context, uci: string, evaluation: AltEval): Alternative {
  const { input, node, index } = context;
  const edge = node?.edges.find((candidate) => candidate.uci === uci);
  const move = legalMove(input.epd, { uci })!;
  const named = input.book.named.get(move.toEpd);
  const inBook = input.book.positions.has(move.toEpd);
  const owned = Boolean(edge && edge.owner && edge.n >= 1);
  const reasons: AltReason[] = [];
  const stats = ownerStatsOf(edge);

  // owned
  if (edge && owned) {
    if (edge.n >= ALT_OWNED_MIN_N && edge.weighted.score >= 0.5) {
      reasons.push({ feature: "owned", points: 4, text: `You already play it: ${games(edge.n)}, ${pct(edge.raw.score)} (expected ${pct(edge.raw.expected)}).` });
    } else {
      reasons.push({ feature: "owned", points: 2, text: `You have played it: ${games(edge.n)}, ${pct(edge.raw.score)} (expected ${pct(edge.raw.expected)}).` });
    }
  }
  // named
  if (named) {
    reasons.push({ feature: "named", points: 3, text: `Named line: ${named.eco} ${named.name}.` });
  } else if (inBook) {
    reasons.push({ feature: "named", points: 1, text: "A book move (on a named line, without its own name)." });
  }
  // mainstream
  const lines = inBook ? input.book.lineCount.get(move.toEpd) ?? 0 : 0;
  const share = context.bookLines > 0 ? lines / context.bookLines : 0;
  if (share >= ALT_MAINSTREAM_HIGH || share >= ALT_MAINSTREAM_LOW) {
    reasons.push({
      feature: "mainstream",
      points: share >= ALT_MAINSTREAM_HIGH ? 2 : 1,
      text: `Mainstream theory: ${pct(share)} of the book's lines from here continue with it (${lines} of ${context.bookLines}).`
    });
  }
  // results against the questioned move
  const currentEdge = context.current?.edge;
  if (edge && owned && currentEdge && currentEdge.uci !== uci && edge.n >= ALT_RESULTS_MIN_N && currentEdge.n >= ALT_RESULTS_MIN_N) {
    const z = siblingZ(edge, currentEdge);
    if (z >= ALT_RESULTS_Z) {
      reasons.push({
        feature: "results",
        points: 2,
        text: `You score ${signedPct(edge.weighted.delta)} against expectation with it and ${signedPct(currentEdge.weighted.delta)} with ${currentEdge.san} (z ${z.toFixed(2)}).`
      });
    }
  }

  const sample = sampleLineOf(input.root, input.epd, uci);
  // familiar: the pawns after the move and up to ALT_FAMILIAR_PLIES more plies
  const compareAt = sample.epds[Math.min(sample.epds.length - 1, ALT_FAMILIAR_PLIES)] ?? move.toEpd;
  const pawns = pawnSet(compareAt);
  const ownSubtree = [...input.path.moves, uci];
  let familiar: { node: TreeNode; similarity: number } | null = null;
  for (const candidate of index.pawns) {
    if (candidate.node.ply < (node?.ply ?? input.path.moves.length) + 3 || candidate.node.epd === compareAt || context.excluded(candidate.node)) {
      continue;
    }
    const nodePath = index.paths.get(candidate.node.epd)?.moves ?? [];
    if (owned && startsWith(nodePath, ownSubtree)) {
      continue;
    }
    const similarity = jaccard(pawns, candidate.pawns);
    if (similarity >= ALT_FAMILIAR_JACCARD && (!familiar || similarity > familiar.similarity || (similarity === familiar.similarity && candidate.node.wN > familiar.node.wN))) {
      familiar = { node: candidate.node, similarity };
    }
  }
  if (familiar) {
    reasons.push({
      feature: "familiar",
      points: 2,
      text: `Same pawn skeleton (${pct(familiar.similarity)} alike) as your ${nodeLabel(index, familiar.node)}, reached in ${games(familiar.node.n)}.`
    });
  }
  // transposes (moves he has not played)
  if (!owned) {
    for (const [plyIndex, epd] of sample.epds.entries()) {
      const target = input.tree.nodes.get(epd);
      if (target && target.n >= ALT_TRANSPOSE_MIN_N) {
        reasons.push({
          feature: "transposes",
          points: 2,
          text: `Transposes into your ${nodeLabel(index, target)} (${games(target.n)}) after ${formatLine(sample.sans.slice(0, plyIndex + 1), input.path.moves.length + 1)}.`
        });
        break;
      }
    }
  }
  // simplicity: only-moves for the owner on the sample line, and forcing plies
  const positions = onlyMovePositions(input.root, input.epd, input.path.moves, uci);
  let checked = 0;
  let found = 0;
  const onlyAt: string[] = [];
  for (const position of positions) {
    const cached = input.lookup?.(position.epd, "owner");
    if (!cached || cached.lines.length < 2) {
      continue;
    }
    checked += 1;
    if (scoreWinPercent(cached.lines[0]) - scoreWinPercent(cached.lines[1]) >= ALT_ONLY_MOVE_GAP) {
      found += 1;
      const at = position.moves.length + 1;
      onlyAt.push(formatLine([legalMove(position.epd, { uci: cached.lines[0].uci })?.san ?? cached.lines[0].uci], at));
    }
  }
  let simplicity = 0;
  if (found) {
    const points = Math.max(ALT_SIMPLICITY_CAP, -found);
    simplicity += points;
    reasons.push({ feature: "only-moves", points, text: `You must then find ${found === 1 ? "an only move" : `${found} only moves`}: ${onlyAt.join(", ")} (every other move loses ${ALT_ONLY_MOVE_GAP}+ win%).` });
  }
  const forcing = sample.sans.filter((san) => san.includes("x") || san.includes("+")).length;
  if (forcing >= ALT_FORCING_PLIES && simplicity > ALT_SIMPLICITY_CAP) {
    simplicity -= 1;
    reasons.push({ feature: "forcing", points: -1, text: `A forcing line: ${forcing} of its ${sample.sans.length} plies are checks or captures.` });
  }
  // eval gap
  const gapPoints = -round2(evaluation.gap);
  reasons.push({
    feature: "eval-gap",
    points: gapPoints === 0 ? 0 : gapPoints,
    text: evaluation.gap < 1 ? "As good as the engine's best move here (within 1 win%)." : `${evaluation.gap.toFixed(1)} win% below the engine's best move here.`
  });

  const score = round2(reasons.reduce((sum, reason) => sum + reason.points, 0));
  const nodeName = edge?.name ?? named?.name ?? null;
  return {
    uci,
    san: move.san,
    kind: owned ? "owned" : inBook ? "book" : "engine-idea",
    eval: evaluation,
    name: named?.name ?? nodeName,
    eco: named?.eco ?? edge?.eco ?? null,
    nameExact: Boolean(named),
    ownerStats: stats,
    sampleLine: { ucis: sample.ucis, sans: sample.sans },
    replies: repliesAfter(input, move.toEpd, sample.ucis[1]),
    reasons,
    score,
    onlyMoves: { positions: positions.length, checked, found },
    isRepertoire: input.entries.get(input.epd)?.uci === uci
  };
}

/** Engine ideas last; then by score, the smaller gap, and the UCI. */
function rankOrder(a: Alternative, b: Alternative): number {
  const ideaA = a.kind === "engine-idea" ? 1 : 0;
  const ideaB = b.kind === "engine-idea" ? 1 : 0;
  return ideaA - ideaB || b.score - a.score || a.eval.gap - b.eval.gap || byUci(a, b);
}

function questionedMove(input: AltInput, node: TreeNode | undefined): { uci: string; source: AltCurrent["source"] } | null {
  if (input.current && legalMove(input.epd, { uci: input.current })) {
    return { uci: input.current, source: "asked" };
  }
  const entry = input.entries.get(input.epd);
  if (entry) {
    return { uci: entry.uci, source: "repertoire" };
  }
  const top = node?.edges.filter((edge) => edge.owner).sort((a, b) => b.n - a.n || b.weighted.wN - a.weighted.wN || byUci(a, b))[0];
  return top ? { uci: top.uci, source: "most-played" } : null;
}

/** The positions before each move of `moves`, from the start (index i: before moves[i]), or null if a move is illegal. */
function pathPositions(moves: readonly string[]): string[] | null {
  const positions: string[] = [];
  let cursor = START_EPD;
  for (const uci of moves) {
    positions.push(cursor);
    const next = legalMove(cursor, { uci });
    if (!next) {
      return null;
    }
    cursor = next.toEpd;
  }
  return positions;
}

/** The questioned move's games, split by the opponent's reply and the owner's answer. */
export function pointsLostAfter(tree: OpeningTree, games: readonly TreeGame[], epd: string, uci: string): PointsLost | null {
  const through = gamesThrough(games, epd, tree.maxPly).filter(({ game, index }) => game.plies[index]?.uci === uci);
  if (!through.length) {
    return null;
  }
  type Acc = { uci: string; san: string; n: number; s: number; lost: number; answers: Map<string, { uci: string; san: string; n: number; s: number; lost: number }> };
  const rows = new Map<string, Acc>();
  let n = 0;
  let s = 0;
  let lost = 0;
  let san = uci;
  for (const { game, index } of through) {
    san = game.plies[index].san;
    const w = recencyWeight(ageDays(game.endTime, tree.now), tree.halfLifeDays);
    const pl = w * (eloExpected(game.myRating, game.oppRating) - game.score);
    n += 1;
    s += game.score;
    lost += pl;
    const reply = game.plies[index + 1];
    const key = reply?.uci ?? "";
    const row = rows.get(key) ?? { uci: key, san: reply?.san ?? "(game over)", n: 0, s: 0, lost: 0, answers: new Map() };
    row.n += 1;
    row.s += game.score;
    row.lost += pl;
    const answer = game.plies[index + 2];
    if (answer) {
      const current = row.answers.get(answer.uci) ?? { uci: answer.uci, san: answer.san, n: 0, s: 0, lost: 0 };
      current.n += 1;
      current.s += game.score;
      current.lost += pl;
      row.answers.set(answer.uci, current);
    }
    rows.set(key, row);
  }
  const toAnswer = (acc: { uci: string; san: string; n: number; s: number; lost: number }): PointsLostAnswer => ({
    uci: acc.uci,
    san: acc.san,
    n: acc.n,
    score: acc.s / acc.n,
    pointsLost: round2(acc.lost)
  });
  const sorted = [...rows.values()].sort((a, b) => b.lost - a.lost || b.n - a.n || byUci(a, b));
  const shown = sorted.slice(0, ALT_LOST_ROWS);
  const rest = sorted.slice(ALT_LOST_ROWS);
  return {
    uci,
    san,
    n,
    score: s / n,
    pointsLost: round2(lost),
    rows: shown.map((row) => ({
      ...toAnswer(row),
      answers: [...row.answers.values()].sort((a, b) => b.lost - a.lost || b.n - a.n || byUci(a, b)).slice(0, ALT_LOST_ANSWERS).map(toAnswer)
    })),
    otherN: rest.reduce((sum, row) => sum + row.n, 0),
    otherPointsLost: round2(rest.reduce((sum, row) => sum + row.lost, 0))
  };
}

const HONESTY = [
  "There is no popularity data here: the app is offline and has no online move statistics. 'Mainstream' only counts how many named lines of the lichess opening list continue with a move.",
  "Every suggestion passed the engine gate (at most 5 win% below Stockfish's best move from your side). A book name is not a recommendation, and being in the book never passes the gate on its own.",
  "The ranking is by fit with your own play (moves you play, named lines, familiar pawn structures, transpositions into your games, how forcing the line is), not by strength alone.",
  `Your own record is shown for moves you have played; below ${LOW_SAMPLE_N} games it is too small to judge and is marked as a low sample.`
];

/** The ranked alternatives at one owner-to-move position. */
export function rankAlternatives(input: AltInput): AlternativesResult {
  const color = input.tree.color;
  const node = input.tree.nodes.get(input.epd);
  const ply = input.path.moves.length + 1;
  const questioned = questionedMove(input, node);
  const currentEdge = questioned ? node?.edges.find((edge) => edge.uci === questioned.uci) : undefined;
  const { gated, rejected } = rankAt({ ...input, current: questioned?.uci ?? null });

  let current: AltCurrent | null = null;
  if (questioned) {
    const evaluation = evalOf(input.root, questioned.uci, color);
    const move = legalMove(input.epd, { uci: questioned.uci })!;
    const flag = input.flags.get(`${input.epd}|${questioned.uci}`) ?? null;
    current = {
      uci: questioned.uci,
      san: move.san,
      source: questioned.source,
      eval: evaluation,
      hole: evaluation !== null && evaluation.gap >= ALT_HOLE_LOSS,
      flag,
      ownerStats: ownerStatsOf(currentEdge),
      name: input.book.named.get(move.toEpd)?.name ?? currentEdge?.name ?? null,
      isRepertoire: input.entries.get(input.epd)?.uci === questioned.uci
    };
  }

  const best = input.root?.lines[0];
  const engine: AltEngineInfo | null =
    input.root && best
      ? {
          tier: input.root.tier === "deep" ? "deep" : "owner",
          depth: input.root.depth,
          nodes: input.root.nodes,
          multipv: input.root.lines.length,
          bestUci: best.uci,
          bestSan: legalMove(input.epd, { uci: best.uci })?.san ?? best.uci
        }
      : null;

  return {
    color,
    epd: input.epd,
    ply,
    moves: input.path.moves,
    sans: input.path.sans,
    name: node?.name ?? null,
    eco: node?.eco ?? null,
    n: node?.n ?? 0,
    gate: ALT_GATE_LOSS,
    engine,
    current,
    alternatives: gated.slice(0, ALT_TOP),
    others: gated.slice(ALT_TOP),
    rejected,
    pointsLost: questioned ? pointsLostAfter(input.tree, input.games, input.epd, questioned.uci) : null,
    ancestors: ancestorSuggestions(input),
    honesty: HONESTY
  };
}

/**
 * "Change earlier": at each earlier owner position of the path, a sibling the owner plays in
 * ALT_RESULTS_MIN_N games that scores better than the path's move with z >= ALT_RESULTS_Z
 * (results), or, when the path's move is a flagged results leak (and not itself the engine's
 * best move), the gated alternatives there from the cached evals (leak).
 */
export function ancestorSuggestions(input: AltInput): AncestorSuggestion[] {
  const color = input.tree.color;
  const suggestions: AncestorSuggestion[] = [];
  const positions = (pathPositions(input.path.moves) ?? []).map((epd, index) => ({ epd, index }));
  for (const { epd: ancestor, index } of positions) {
    if (mover(ancestor) !== color) {
      continue;
    }
    const node = input.tree.nodes.get(ancestor);
    const uci = input.path.moves[index];
    const edge = node?.edges.find((candidate) => candidate.uci === uci);
    if (!node || !edge) {
      continue;
    }
    const rootEval = input.ancestorRoot?.(ancestor) ?? input.lookup?.(ancestor, "owner");
    const gapOf = (move: string) => evalOf(rootEval, move, color)?.gap ?? null;
    const moveOf = (candidate: TreeEdge | undefined, move: string): AncestorMove => ({
      uci: move,
      san: candidate?.san ?? legalMove(ancestor, { uci: move })?.san ?? move,
      n: candidate?.n ?? 0,
      score: candidate && candidate.n ? candidate.raw.score : null,
      gap: gapOf(move),
      name: candidate?.name ?? input.book.named.get(legalMove(ancestor, { uci: move })?.toEpd ?? "")?.name ?? null
    });
    const base = { epd: ancestor, ply: index + 1, moves: input.path.moves.slice(0, index), sans: input.path.sans.slice(0, index), instead: moveOf(edge, uci) };

    // results: a clearly better-scoring sibling the owner plays often
    if (edge.n >= ALT_RESULTS_MIN_N) {
      const better = node.edges
        .filter((sibling) => sibling.owner && sibling.uci !== uci && sibling.n >= ALT_RESULTS_MIN_N)
        .map((sibling) => ({ sibling, z: siblingZ(sibling, edge), gap: gapOf(sibling.uci) }))
        .filter((entry) => entry.z >= ALT_RESULTS_Z && (entry.gap === null || entry.gap <= ALT_GATE_LOSS))
        .sort((a, b) => b.z - a.z || byUci(a.sibling, b.sibling));
      if (better.length) {
        const top = better[0];
        suggestions.push({
          ...base,
          kind: "results",
          play: better.map((entry) => moveOf(entry.sibling, entry.sibling.uci)),
          reason:
            `After ${formatLine(base.sans) || "the start"} you score ${pct(top.sibling.raw.score)} with ${formatLine([top.sibling.san], index + 1)} (${games(top.sibling.n)}, ` +
            `${signedPct(top.sibling.weighted.delta)} against expectation) and ${pct(edge.raw.score)} with ${formatLine([edge.san], index + 1)} ` +
            `(${games(edge.n)}, ${signedPct(edge.weighted.delta)}), z ${top.z.toFixed(2)}.`
        });
        continue;
      }
    }

    // leak: the path's move is a flagged results leak; suggest the gated alternatives there
    const flag = input.flags.get(`${ancestor}|${uci}`);
    const pathGap = gapOf(uci);
    if (flag && flag.n >= ALT_FLAG_MIN_N && !(pathGap !== null && pathGap < 1)) {
      const sub: AltInput = {
        ...input,
        epd: ancestor,
        path: { moves: base.moves, sans: base.sans },
        root: rootEval,
        current: uci,
        ancestorRoot: undefined
      };
      const ranked = rankAt(sub).gated;
      if (ranked.length) {
        suggestions.push({
          ...base,
          kind: "leak",
          play: ranked.slice(0, ALT_TOP).map((alternative) => moveOf(node.edges.find((candidate) => candidate.uci === alternative.uci), alternative.uci)),
          reason: `${formatLine([...base.sans, edge.san])}: you score ${pct(flag.score)} over ${games(flag.n)} (expected ${pct(flag.expected)}, z ${flag.z.toFixed(2)}).`
        });
      }
    }
  }
  return suggestions;
}

/** The gated alternatives at a position, ranked, without the questioned move `input.current` (the seed's replacement). */
export function rankedMoves(input: AltInput): Alternative[] {
  return rankAt(input).gated;
}

/** The gated candidates at a position (ranked, the questioned move `input.current` left out) and the rejected ones. */
function rankAt(input: AltInput): { gated: Alternative[]; rejected: AltRejected[] } {
  const node = input.tree.nodes.get(input.epd);
  const index = treeIndex(input.tree);
  const currentEdge = input.current ? node?.edges.find((edge) => edge.uci === input.current) : undefined;
  const bookLines = mainstreamChildren(input.book, input.epd).reduce((sum, child) => sum + child.lines, 0);
  // The positions on the way here and the questioned move's own subtree are not "familiar
  // structures": they are this line itself.
  const onPath = new Set(pathPositions(input.path.moves) ?? []);
  const prefix = input.current ? [...input.path.moves, input.current] : null;
  const context: Context = {
    input,
    color: input.tree.color,
    node,
    index,
    bookLines,
    current: input.current ? { uci: input.current, edge: currentEdge } : null,
    excluded: (candidate) => {
      const nodePath = index.paths.get(candidate.epd)?.moves ?? [];
      return candidate.epd === input.epd || onPath.has(candidate.epd) || (prefix !== null && startsWith(nodePath, prefix));
    }
  };
  const gated: Alternative[] = [];
  const rejected: AltRejected[] = [];
  for (const uci of alternativeCandidates(node, input.epd, input.book, input.root, input.current)) {
    if (uci === input.current) {
      continue;
    }
    const evaluation = evalOf(input.root, uci, input.tree.color);
    const san = legalMove(input.epd, { uci })!.san;
    if (!evaluation) {
      rejected.push({ uci, san, gap: null, reason: "Not scored by the engine yet." });
    } else if (evaluation.gap > ALT_GATE_LOSS) {
      rejected.push({ uci, san, gap: evaluation.gap, reason: `${evaluation.gap.toFixed(1)} win% below the engine's best move (the gate is ${ALT_GATE_LOSS}).` });
    } else {
      gated.push(buildAlternative(context, uci, evaluation));
    }
  }
  gated.sort(rankOrder);
  rejected.sort((a, b) => (a.gap ?? Infinity) - (b.gap ?? Infinity) || byUci(a, b));
  return { gated, rejected };
}

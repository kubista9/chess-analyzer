import { benjaminiHochberg, normalSf, trendDirection, type TrendDirection } from "./moveSignals.js";
import { formatLine, principalPaths, type OpeningTree, type TreeEdge, type TreeGame, type TreeTrend } from "./openingTree.js";
import { addGame, ageDays, eloExpected, emptyAccumulator, LOW_SAMPLE_N, recencyWeight, summarize, type ScoreAccumulator } from "./stats.js";
import type { PlayerColor } from "./types.js";

// Fix list v0: the opening lines where the owner loses the most points against his Elo
// expectation, from results only (no engine). Pure; the server feeds it the memoised trees.
//
// Candidates are the owner's own moves (edges out of owner-to-move positions) in both colours'
// trees, within the tree's opening window, with at least 8 raw games and an effective n of 8.
// The P3 critic's null simulation showed that the plan's gate (z >= 1 or Wilson hi < 50%) flags
// as many lines on coin-flip results as on the real games, so a candidate is significant only
// when z >= 1.64 AND it is a Benjamini-Hochberg discovery at q = 0.2 across the whole candidate
// set (both colours; one-sided p, since only "below expectation" is tested).
//
// Blame attribution runs bottom-up over the significant candidates: the deepest move is judged
// first, and a game that an emitted deeper item already explains no longer counts for its
// ancestors. A move is emitted only if what is left (its residual) still has 8 games, loses at
// least 1 weighted point and has z >= 1, so a parent and its child are never both listed for
// the same lost points. Items are ranked by those residual weighted points lost.

export const FIX_MIN_N = LOW_SAMPLE_N;
export const FIX_MIN_ESS = 8;
export const FIX_MIN_Z = 1.64;
export const FIX_FDR_Q = 0.2;
/** An item's residual must lose at least this many (recency-weighted) points... */
export const FIX_MIN_POINTS = 1;
/** ...over at least FIX_MIN_N residual games, with at least this residual z. */
export const FIX_MIN_RESIDUAL_Z = 1;
/** Confidence is "high" from this z (one-sided 99%), otherwise "medium". */
export const FIX_HIGH_Z = 2.33;
/** A loss within this many half-moves (move 20) counts as an early loss. */
export const EARLY_LOSS_PLY = 40;
/** Example games per item (the most recent losses first). */
export const FIX_EXAMPLES = 3;

export interface CandidateGame {
  id: string;
  endTime: number;
  /** Recency weight in the tree's view. */
  w: number;
  /** Elo expectation. */
  e: number;
  s: number;
  /** The ply at which the game played the candidate move. */
  ply: number;
  plyCount: number | null;
}

export interface FixCandidate {
  color: PlayerColor;
  /** UCI moves from the start, the candidate move last. */
  moves: string[];
  sans: string[];
  edge: TreeEdge;
  /** Newest first. */
  games: CandidateGame[];
}

/**
 * The owner-move candidates of one colour's tree; `games` are the games the tree was built from.
 * The sample gates are overridable only so the verify script can re-run the critic's setup.
 */
export function collectCandidates(
  tree: OpeningTree,
  games: readonly TreeGame[],
  { minN = FIX_MIN_N, minEss = FIX_MIN_ESS }: { minN?: number; minEss?: number } = {}
): FixCandidate[] {
  const byId = new Map(games.map((game) => [game.id, game]));
  const paths = principalPaths(tree);
  const candidates: FixCandidate[] = [];
  for (const node of tree.nodes.values()) {
    if (!node.ownerToMove) {
      continue;
    }
    const path = paths.get(node.epd);
    if (!path) {
      continue;
    }
    for (const edge of node.edges) {
      if (edge.n < minN || edge.weighted.ess < minEss) {
        continue;
      }
      const candidateGames = edge.gameIds.map((id): CandidateGame => {
        const game = byId.get(id);
        if (!game) {
          throw new Error(`Game ${id} is in the tree but not in the game list`);
        }
        const index = game.plies.findIndex((ply) => ply.epdBefore === node.epd && ply.uci === edge.uci);
        return {
          id,
          endTime: game.endTime,
          w: recencyWeight(ageDays(game.endTime, tree.now), tree.halfLifeDays),
          e: eloExpected(game.myRating, game.oppRating),
          s: game.score,
          ply: index + 1,
          plyCount: game.plyCount ?? null
        };
      });
      candidates.push({ color: tree.color, moves: [...path.moves, edge.uci], sans: [...path.sans, edge.san], edge, games: candidateGames });
    }
  }
  return candidates;
}

export type FixConfidence = "medium" | "high";
/** leak = a BH discovery; watch = nominally significant only (see FixSelection.watch). */
export type FixTier = "leak" | "watch";

export interface FixExample {
  id: string;
  /** For /review/:id?ply=N. */
  ply: number;
  score: number;
  endTime: number;
}

/** One line of the fix list. */
export interface FixItem {
  kind: "results-leak";
  tier: FixTier;
  /** "<color>:<uci,uci,...>" */
  id: string;
  color: PlayerColor;
  /** UCI moves from the start; the last one is the owner's move the item is about. */
  moves: string[];
  sans: string[];
  /** "1.e4 e5" */
  line: string;
  /** Book name of the position the move reaches. */
  name: string | null;
  eco: string | null;
  nameExact: boolean;
  inBook: boolean;
  /** The whole line (every game that played the move), in the tree's view. */
  n: number;
  wins: number;
  draws: number;
  losses: number;
  wN: number;
  ess: number;
  score: number;
  ci: [number, number];
  expected: number;
  delta: number;
  /** Σw(s - E) over the whole line (negative for a leak). */
  deltaPts: number;
  z: number;
  /** One-sided p and its Benjamini-Hochberg adjusted value over the candidate set. */
  p: number;
  q: number;
  confidence: FixConfidence;
  /** Unweighted score and Δ, for tooltips next to the weighted ones. */
  raw: { score: number; delta: number; deltaPts: number };
  /** The points this item is blamed for: Σw(E - s) over the games no deeper item explains (ranked on this). */
  pointsLost: number;
  /** Those games. */
  residualN: number;
  /** Ids of the deeper items that explain the rest of this line's games. */
  explainedBy: string[];
  trend: TreeTrend & { direction: TrendDirection };
  /** Losses within EARLY_LOSS_PLY half-moves, as a share of the line's games. */
  earlyLoss: { ply: number; n: number; rate: number };
  /** Up to FIX_EXAMPLES of the games this item is blamed for: the most recent losses first. */
  examples: FixExample[];
}

export interface FixSelection {
  /** Candidates tested (the BH family). */
  tested: number;
  /** Candidates with z >= FIX_MIN_Z that are BH discoveries. */
  significant: number;
  /** The leaks, ranked by pointsLost, then n. */
  items: FixItem[];
  /**
   * Lines with z >= FIX_MIN_Z on their own that do not survive BH across the candidate set:
   * worth watching, but as likely as not noise. Same attribution and ranking.
   */
  watch: FixItem[];
}

const itemId = (candidate: Pick<FixCandidate, "color" | "moves">) => `${candidate.color}:${candidate.moves.join(",")}`;

/**
 * The gate, blame attribution and ranking over every candidate (pass both colours' candidates
 * together: they form one BH family). `scoreOf` replaces each game's score (for null simulations).
 */
export function selectLeaks(candidates: readonly FixCandidate[], scoreOf?: (game: CandidateGame) => number): FixSelection {
  const s = scoreOf ?? ((game: CandidateGame) => game.s);
  const stats = candidates.map((candidate) => {
    const acc = emptyAccumulator();
    for (const game of candidate.games) {
      addGame(acc, game.w, s(game), game.e);
    }
    const summary = summarize(acc);
    const z = summary.z ?? 0;
    return { candidate, acc, summary, z, p: summary.z === null ? 1 : normalSf(z) };
  });
  const discovered = benjaminiHochberg(stats.map((entry) => entry.p), FIX_FDR_Q);
  const qValues = bhAdjusted(stats.map((entry) => entry.p));
  const nominal = stats
    .map((entry, index) => ({ ...entry, q: qValues[index], tier: (discovered[index] ? "leak" : "watch") as FixTier }))
    .filter((entry) => entry.z >= FIX_MIN_Z);

  // Deepest first. A game explained by an emitted item at a later ply of that game no longer
  // counts for the items above it. Leaks only give way to deeper leaks; watch items give way
  // to deeper leaks and deeper watch items, so noise-level lines never shrink a leak.
  nominal.sort((a, b) => b.candidate.moves.length - a.candidate.moves.length || b.z - a.z);
  const leakClaims = new Map<string, Claim>();
  const allClaims = new Map<string, Claim>();
  const items: FixItem[] = [];
  const watch: FixItem[] = [];
  for (const entry of nominal) {
    const { candidate, tier } = entry;
    const claims = tier === "leak" ? leakClaims : allClaims;
    const residual: ScoreAccumulator = emptyAccumulator();
    const residualGames: CandidateGame[] = [];
    const explainedBy = new Set<string>();
    for (const game of candidate.games) {
      const claim = claims.get(game.id);
      if (claim && claim.ply > game.ply) {
        explainedBy.add(claim.item);
        continue;
      }
      addGame(residual, game.w, s(game), game.e);
      residualGames.push(game);
    }
    const pointsLost = residual.sumWE - residual.sumWS;
    const residualZ = summarize(residual).z ?? 0;
    if (residual.n < FIX_MIN_N || pointsLost < FIX_MIN_POINTS || residualZ < FIX_MIN_RESIDUAL_Z) {
      continue;
    }
    const id = itemId(candidate);
    for (const game of residualGames) {
      for (const map of tier === "leak" ? [leakClaims, allClaims] : [allClaims]) {
        if (!map.has(game.id)) {
          map.set(game.id, { ply: game.ply, item: id });
        }
      }
    }
    (tier === "leak" ? items : watch).push(toItem(candidate, entry, s, pointsLost, residualGames, [...explainedBy]));
  }

  const rank = (a: FixItem, b: FixItem) => b.pointsLost - a.pointsLost || b.n - a.n || (a.id < b.id ? -1 : 1);
  return {
    tested: candidates.length,
    significant: nominal.filter((entry) => entry.tier === "leak").length,
    items: items.sort(rank),
    watch: watch.sort(rank)
  };
}

interface Claim {
  /** The ply at which the claiming item's move was played in that game. */
  ply: number;
  item: string;
}

/** Benjamini-Hochberg adjusted p-values (q-values), in input order. */
export function bhAdjusted(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => b.p - a.p);
  const result = new Array<number>(m);
  let running = 1;
  for (const [position, { p, index }] of order.entries()) {
    const rank = m - position;
    running = Math.min(running, (p * m) / rank);
    result[index] = running;
  }
  return result;
}

function toItem(
  candidate: FixCandidate,
  entry: { summary: ReturnType<typeof summarize>; z: number; p: number; q: number; tier: FixTier },
  s: (game: CandidateGame) => number,
  pointsLost: number,
  residualGames: CandidateGame[],
  explainedBy: string[]
): FixItem {
  const { edge, games } = candidate;
  const { summary } = entry;
  const rawAcc = emptyAccumulator();
  let wins = 0;
  let draws = 0;
  let early = 0;
  for (const game of games) {
    const score = s(game);
    addGame(rawAcc, 1, score, game.e);
    wins += score === 1 ? 1 : 0;
    draws += score === 0.5 ? 1 : 0;
    early += score === 0 && game.plyCount !== null && game.plyCount <= EARLY_LOSS_PLY ? 1 : 0;
  }
  const raw = summarize(rawAcc);
  // The most recent losses, then draws, then wins, among the games this item is blamed for
  // (a deeper item shows its own). Games are newest first.
  const examples = [...residualGames]
    .map((game, order) => ({ game, order, score: s(game) }))
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, FIX_EXAMPLES)
    .map(({ game, score }) => ({ id: game.id, ply: game.ply, score, endTime: game.endTime }));

  return {
    kind: "results-leak",
    tier: entry.tier,
    id: itemId(candidate),
    color: candidate.color,
    moves: candidate.moves,
    sans: candidate.sans,
    line: formatLine(candidate.sans),
    name: edge.name,
    eco: edge.eco,
    nameExact: edge.nameExact,
    inBook: edge.inBook,
    n: games.length,
    wins,
    draws,
    losses: games.length - wins - draws,
    wN: summary.wN,
    ess: summary.ess,
    score: summary.score,
    ci: summary.ci,
    expected: summary.expected,
    delta: summary.delta,
    deltaPts: summary.deltaPts,
    z: entry.z,
    p: entry.p,
    q: entry.q,
    confidence: entry.z >= FIX_HIGH_Z ? "high" : "medium",
    raw: { score: raw.score, delta: raw.delta, deltaPts: raw.deltaPts },
    pointsLost,
    residualN: residualGames.length,
    explainedBy,
    trend: { ...edge.trend, direction: trendDirection(edge.trend) },
    earlyLoss: { ply: EARLY_LOSS_PLY, n: early, rate: games.length ? early / games.length : 0 },
    examples
  };
}

/** The fix list over both colours' trees (one BH family). */
export function buildFixList(trees: readonly { tree: OpeningTree; games: readonly TreeGame[] }[]): FixSelection {
  return selectLeaks(trees.flatMap(({ tree, games }) => collectCandidates(tree, games)));
}

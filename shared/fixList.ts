import { CATEGORY_THRESHOLDS, classifyLoss, cpEquivalent } from "./eval.js";
import { benjaminiHochberg, normalSf, trendDirection, type TrendDirection } from "./moveSignals.js";
import {
  coverageOk,
  firstErrorShares,
  meanEvalAt,
  rootVerdict,
  round2,
  sanOf,
  topFirstMistakes,
  whitePoint,
  type EvalLookup,
  type FirstMistake,
  type GameOpeningAnalysis,
  type OwnerMoveScored,
  type WhiteEvalPoint
} from "./openingAnalysis.js";
import { formatLine, principalPaths, type OpeningTree, type TreeEdge, type TreeGame, type TreeTrend } from "./openingTree.js";
import { addGame, ageDays, eloExpected, emptyAccumulator, LOW_SAMPLE_N, recencyWeight, summarize, type ScoreAccumulator } from "./stats.js";
import type { MoveCategory, PlayerColor } from "./types.js";

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

/**
 * Engine facts about a results leak's games, from the per-game analyses. Each part carries how
 * many games it is known for; `shown` is false below the minimum coverage (coverageOk).
 */
export interface LeakEngineStats {
  games: number;
  /** Games with every ply of the window scored. */
  complete: number;
  /** The owner's mean eval after ply 20 (move 10). */
  evalAt20: { known: number; cp: number; winPct: number; shown: boolean } | null;
  /** Games with a first mistake (or worse) by ply 20, over the games where that is known. */
  firstError: { known: number; errors: number; rate: number | null; shown: boolean };
  /** The most common first mistake and the engine's move there. */
  topFirstMistake: FirstMistake | null;
}

/** One results line of the fix list. */
export interface ResultsLeakItem {
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
  /** The ranking key shared with engine holes: the residual points lost (pointsLost). */
  impact: number;
  /** null without engine data (no engine config). */
  engine: LeakEngineStats | null;
}

/**
 * A theory hole: an owner move the engine refutes, whatever its results. Not part of the BH
 * family (the engine is not a statistical test); ranked with the leaks by impact.
 */
export interface EngineHoleItem {
  kind: "engine-hole";
  /** "hole:<color>:<uci,uci,...>" */
  id: string;
  color: PlayerColor;
  moves: string[];
  sans: string[];
  line: string;
  /** The line up to the position the move is played from ("1.e4 e5 2.Nf3"). */
  before: string;
  name: string | null;
  eco: string | null;
  nameExact: boolean;
  inBook: boolean;
  n: number;
  wN: number;
  /** Raw results of the move, for context ("even though you score 47%"). */
  score: number;
  expected: number;
  /** The owner's win% loss at the move's root, and its class. */
  loss: number;
  cls: MoveCategory;
  bestUci: string;
  bestSan: string;
  /** The owner's eval (cp from his side, mate > 0 when he mates) with the best move and with the played one. */
  ownerEval: { best: { cp: number; mate: number | null }; played: { cp: number; mate: number | null } };
  /** The same from White's side. */
  whiteEval: { best: WhiteEvalPoint; played: WhiteEvalPoint };
  /** The opponent's best reply (null when the position after the move is not analysed) and its eval for him. */
  reply: { uci: string; san: string; cpForThem: number; mate: number | null } | null;
  /** Which gate the move passed. */
  gates: { loss: boolean; reply: boolean };
  /** Expected points the move itself gives away: wN x loss / 100. */
  impact: number;
  examples: FixExample[];
}

export type FixItem = ResultsLeakItem | EngineHoleItem;

export interface FixSelection {
  /** Candidates tested (the BH family). */
  tested: number;
  /** Candidates with z >= FIX_MIN_Z that are BH discoveries. */
  significant: number;
  /** The leaks, ranked by pointsLost, then n. */
  items: ResultsLeakItem[];
  /**
   * Lines with z >= FIX_MIN_Z on their own that do not survive BH across the candidate set:
   * worth watching, but as likely as not noise. Same attribution and ranking.
   */
  watch: ResultsLeakItem[];
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
  const items: ResultsLeakItem[] = [];
  const watch: ResultsLeakItem[] = [];
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

  const rank = (a: ResultsLeakItem, b: ResultsLeakItem) => b.pointsLost - a.pointsLost || b.n - a.n || (a.id < b.id ? -1 : 1);
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
): ResultsLeakItem {
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
    examples,
    impact: pointsLost,
    engine: null
  };
}

// Engine holes (fix list v1). The critic measured 2...Bc5 at 9.5-11.5 win% depending on the
// budget, right on the mistake line, so the gate is not "mistake or worse": a move is a hole
// when it loses >= 7 win%, or when it loses at least an inaccuracy's worth (5) and the
// opponent's best reply is >= +100 cp for him.

/** Raw games of the move at least... */
export const ENGINE_HOLE_MIN_N = 3;
/** ...and a win% loss of at least this, */
export const ENGINE_HOLE_MIN_LOSS = 7;
/** or at least an inaccuracy (this loss) with the opponent's best reply this good for him (cp). */
export const ENGINE_HOLE_REPLY_LOSS = CATEGORY_THRESHOLDS.good;
export const ENGINE_HOLE_REPLY_CP = 100;
/** Items the ranked list shows before "show all". */
export const FIX_LIST_CAP = 10;

/** What the fix list needs from the engine: the position cache and the per-game analyses. */
export interface FixEngine {
  lookup: EvalLookup;
  analysisOf: (game: TreeGame) => GameOpeningAnalysis;
}

function ownerScore(line: { cp: number | null; mate: number | null }) {
  return { cp: cpEquivalent(line), mate: line.mate };
}

/** The engine holes of one colour's tree, ranked by impact. */
export function collectEngineHoles(tree: OpeningTree, games: readonly TreeGame[], engine: FixEngine): EngineHoleItem[] {
  const byId = new Map(games.map((game) => [game.id, game]));
  const paths = principalPaths(tree);
  const holes: EngineHoleItem[] = [];
  for (const node of tree.nodes.values()) {
    const path = paths.get(node.epd);
    if (!node.ownerToMove || !path) {
      continue;
    }
    const root = engine.lookup(node.epd, "owner");
    for (const edge of node.edges) {
      if (edge.n < ENGINE_HOLE_MIN_N) {
        continue;
      }
      const verdict = rootVerdict(root, edge.uci);
      if (!verdict) {
        continue;
      }
      const child = engine.lookup(edge.toEpd, "opponent");
      const replyLine = child?.lines[0];
      const reply = replyLine
        ? { uci: replyLine.uci, san: sanOf(edge.toEpd, replyLine.uci), cpForThem: cpEquivalent(replyLine), mate: replyLine.mate }
        : null;
      // Without the child's search, the played move's score at the root stands in for the reply.
      const cpForThem = reply ? reply.cpForThem : -cpEquivalent(verdict.played);
      const gates = {
        loss: verdict.loss >= ENGINE_HOLE_MIN_LOSS,
        reply: verdict.loss >= ENGINE_HOLE_REPLY_LOSS && cpForThem >= ENGINE_HOLE_REPLY_CP
      };
      if (!gates.loss && !gates.reply) {
        continue;
      }
      const moves = [...path.moves, edge.uci];
      const sans = [...path.sans, edge.san];
      const mover = tree.color;
      const examples = edge.gameIds.slice(0, FIX_EXAMPLES).map((id): FixExample => {
        const game = byId.get(id);
        const index = game ? game.plies.findIndex((ply) => ply.epdBefore === node.epd && ply.uci === edge.uci) : -1;
        return { id, ply: index + 1, score: game?.score ?? 0, endTime: game?.endTime ?? 0 };
      });
      holes.push({
        kind: "engine-hole",
        id: `hole:${tree.color}:${moves.join(",")}`,
        color: tree.color,
        moves,
        sans,
        line: formatLine(sans),
        before: formatLine(path.sans),
        name: edge.name,
        eco: edge.eco,
        nameExact: edge.nameExact,
        inBook: edge.inBook,
        n: edge.n,
        wN: edge.weighted.wN,
        score: edge.raw.score,
        expected: edge.raw.expected,
        loss: round2(verdict.loss),
        cls: classifyLoss(verdict.loss),
        bestUci: verdict.best.uci,
        bestSan: sanOf(node.epd, verdict.best.uci),
        ownerEval: { best: ownerScore(verdict.best), played: ownerScore(verdict.played) },
        whiteEval: { best: whitePoint(verdict.best, mover), played: whitePoint(verdict.played, mover) },
        reply,
        gates,
        impact: (edge.weighted.wN * verdict.loss) / 100,
        examples
      });
    }
  }
  return holes.sort((a, b) => b.impact - a.impact || b.n - a.n || (a.id < b.id ? -1 : 1));
}

/** Engine facts about the games of a results leak (see LeakEngineStats). */
export function leakEngineStats(games: readonly TreeGame[], engine: FixEngine): LeakEngineStats {
  const analyses = games.map((game) => engine.analysisOf(game));
  const evalAt20 = meanEvalAt(analyses, 20);
  const [share] = firstErrorShares(analyses, [20]);
  const firsts = analyses
    .map((analysis) => analysis.firstOwnerError)
    .filter((first): first is OwnerMoveScored => first !== null && first !== "pending");
  return {
    games: analyses.length,
    complete: analyses.filter((analysis) => analysis.status === "complete").length,
    evalAt20: evalAt20 ? { ...evalAt20, shown: coverageOk(evalAt20.known, analyses.length) } : null,
    firstError: { known: share.known, errors: share.errors, rate: share.rate, shown: coverageOk(share.known, analyses.length) },
    topFirstMistake: topFirstMistakes(firsts, 1)[0] ?? null
  };
}

export interface FixList extends FixSelection {
  /** Engine holes over both colours (empty without engine data). */
  holes: EngineHoleItem[];
  /** Leaks and engine holes merged by impact (the watch tier stays apart). */
  ranked: FixItem[];
}

/** The fix list over both colours' trees (the leaks form one BH family), with engine holes when `engine` is given. */
export function buildFixList(trees: readonly { tree: OpeningTree; games: readonly TreeGame[] }[], engine?: FixEngine): FixList {
  const candidates = trees.flatMap(({ tree, games }) => collectCandidates(tree, games));
  const selection = selectLeaks(candidates);
  if (!engine) {
    return { ...selection, holes: [], ranked: [...selection.items] };
  }
  const byId = new Map(trees.flatMap(({ games }) => games.map((game) => [`${game.color}:${game.id}`, game] as const)));
  const byItem = new Map(candidates.map((candidate) => [itemId(candidate), candidate]));
  const withStats = (item: ResultsLeakItem): ResultsLeakItem => {
    const candidate = byItem.get(item.id)!;
    const games = candidate.games.map((game) => byId.get(`${candidate.color}:${game.id}`)!);
    return { ...item, engine: leakEngineStats(games, engine) };
  };
  const items = selection.items.map(withStats);
  const watch = selection.watch.map(withStats);
  const holes = trees
    .flatMap(({ tree, games }) => collectEngineHoles(tree, games, engine))
    .sort((a, b) => b.impact - a.impact || b.n - a.n || (a.id < b.id ? -1 : 1));
  const ranked: FixItem[] = [...items, ...holes].sort((a, b) => b.impact - a.impact || b.n - a.n || (a.id < b.id ? -1 : 1));
  return { ...selection, items, watch, holes, ranked };
}

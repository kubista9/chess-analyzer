import { alternativeCandidates, onlyMovePositions, rankAlternatives, type AltCost, type AltInput, type AlternativesResult } from "../../shared/alternatives.js";
import type { EvalLookup } from "../../shared/openingAnalysis.js";
import type { OpeningBook } from "../../shared/openingBook.js";
import type { OpeningTree, TreeGame, TreePath } from "../../shared/openingTree.js";
import type { ColorRepertoire } from "../../shared/repertoire.js";
import type { SeedFlag } from "../../shared/repertoireSeed.js";
import type { PositionEval } from "../../shared/types.js";
import type { Db } from "../db/connection.js";
import { getDeepEval, getPositionEval, putPositionEval } from "../db/positions.js";
import type { PositionRequest } from "../engine/analysePosition.js";
import type { EnginePool } from "../engine/pool.js";
import { isAnswered } from "./openingPass.js";

// The alternatives panel over the store. The root is searched once in the lazy deep tier
// (DEEP_TIER: MultiPV 4 at depth 18, scoring every candidate the book and the owner's games add
// with a depth-matched searchmoves follow-up), and each gated candidate's owner positions on its
// sample line get an ordinary owner-tier search for the only-move check. Everything is stored in
// `positions`, so a second open is answered from the cache at once.

/**
 * Gated candidates whose sample lines get the only-move searches: book and owned moves before
 * engine ideas, then by the eval gap. The order does not depend on the only-move results, so a
 * second open never finds new positions to search.
 */
export const ALT_ONLY_MOVE_CANDIDATES = 8;

export interface AltSource {
  tree: OpeningTree;
  games: readonly TreeGame[];
  book: OpeningBook;
  epd: string;
  path: TreePath;
  /** The owner-tier cache (the analysis index), or null without an engine. */
  lookup: EvalLookup | null;
  flags: ReadonlyMap<string, SeedFlag>;
  entries: ColorRepertoire;
  current: string | null;
}

export interface AltEngineDeps {
  db: Db;
  pool: Pick<EnginePool, "analyseGame">;
  configId: number;
}

/**
 * The moves the deep search must score besides its MultiPV lines: the book children, the owned
 * moves, and whichever move the panel may question (the asked one, the repertoire's, the most played).
 */
export function deepPlayed(source: AltSource): string[] {
  const node = source.tree.nodes.get(source.epd);
  const played = new Set(alternativeCandidates(node, source.epd, source.book, undefined, source.current));
  const entry = source.entries.get(source.epd);
  if (entry) {
    played.add(entry.uci);
  }
  const top = node?.edges.filter((edge) => edge.owner).sort((a, b) => b.n - a.n || b.weighted.wN - a.weighted.wN || (a.uci < b.uci ? -1 : 1))[0];
  if (top) {
    played.add(top.uci);
  }
  return [...played].sort();
}

function rankWith(source: AltSource, root: PositionEval | undefined, lookup: EvalLookup | null, db: Db | null, configId: number | null): AlternativesResult {
  const input: AltInput = {
    tree: source.tree,
    games: source.games,
    book: source.book,
    epd: source.epd,
    path: source.path,
    root,
    lookup,
    ancestorRoot: db && configId !== null ? (epd) => getDeepEval(db, configId, epd) : undefined,
    current: source.current,
    flags: source.flags,
    entries: source.entries
  };
  return rankAlternatives(input);
}

/** Owner-tier positions on the gated candidates' sample lines that the cache has not searched. */
function missingOnlyMovePositions(result: AlternativesResult, root: PositionEval, source: AltSource, lookup: EvalLookup | null): { epd: string; moves: string[] }[] {
  const missing = new Map<string, { epd: string; moves: string[] }>();
  const gated = [...result.alternatives, ...result.others].sort(
    (a, b) => Number(a.kind === "engine-idea") - Number(b.kind === "engine-idea") || a.eval.gap - b.eval.gap || (a.uci < b.uci ? -1 : 1)
  );
  for (const alternative of gated.slice(0, ALT_ONLY_MOVE_CANDIDATES)) {
    for (const position of onlyMovePositions(root, source.epd, source.path.moves, alternative.uci)) {
      const cached = lookup?.(position.epd, "owner");
      if (!cached || !cached.lines.length) {
        missing.set(position.epd, position);
      }
    }
  }
  return [...missing.values()].sort((a, b) => (a.epd < b.epd ? -1 : a.epd > b.epd ? 1 : 0));
}

export type AltState =
  | { ready: true; result: AlternativesResult }
  /** The deep row is missing or incomplete, or only-move positions are unsearched: `preliminary` ranks on the owner-tier row. */
  | { ready: false; preliminary: AlternativesResult; deep: PositionEval | undefined; played: string[] };

/** The alternatives from what the store holds now, and whether the engine still has work to do. */
export function alternativesState(source: AltSource, deps: { db: Db; configId: number } | null): AltState {
  if (!deps) {
    return { ready: true, result: rankWith(source, undefined, null, null, null) };
  }
  const deep = getDeepEval(deps.db, deps.configId, source.epd);
  const played = deepPlayed(source);
  if (deep && isAnswered(deep, played)) {
    const result = rankWith(source, deep, source.lookup, deps.db, deps.configId);
    if (!missingOnlyMovePositions(result, deep, source, source.lookup).length) {
      return { ready: true, result };
    }
    return { ready: false, preliminary: result, deep, played };
  }
  const owner = source.lookup?.(source.epd, "owner") ?? getPositionEval(deps.db, deps.configId, source.epd, "owner");
  return { ready: false, preliminary: rankWith(source, owner, source.lookup, deps.db, deps.configId), deep, played };
}

/**
 * Runs the missing engine work at interactive priority: the deep root (with every candidate
 * scored), then the only-move positions of the gated candidates (one group each, so the pool's
 * workers share them). Each result is stored as it arrives.
 */
export async function completeAlternatives(
  deps: AltEngineDeps,
  source: AltSource,
  refreshLookup: () => EvalLookup | null,
  onProgress?: (done: number, total: number, message: string) => void
): Promise<{ result: AlternativesResult; cost: AltCost }> {
  const started = performance.now();
  const cost: AltCost = { ms: 0, nodes: { deep: 0, onlyMoves: 0 }, searched: 0 };
  const played = deepPlayed(source);
  let deep = getDeepEval(deps.db, deps.configId, source.epd);
  if (!deep || !isAnswered(deep, played)) {
    onProgress?.(0, 1, "Deep engine check of the position (MultiPV 4, depth 18)");
    const before = deep?.lines.length ? deep.nodes : 0;
    const request: PositionRequest = { moves: source.path.moves, tier: "deep", played, cached: deep ?? null };
    const [evaluation] = await deps.pool.analyseGame(`alternatives:${source.epd}`, [request], {
      priority: "interactive",
      onResult: (_slot, result) => putPositionEval(deps.db, deps.configId, result)
    });
    deep = evaluation;
    cost.nodes.deep = Math.max(0, evaluation.nodes - before);
    cost.searched += 1;
  }

  const lookupNow = refreshLookup();
  const first = rankWith(source, deep, lookupNow, deps.db, deps.configId);
  const missing = missingOnlyMovePositions(first, deep, source, lookupNow);
  if (missing.length) {
    let done = 0;
    onProgress?.(0, missing.length, `Checking the sample lines for only-moves: 0 of ${missing.length}`);
    await Promise.all(
      missing.map((position) =>
        deps.pool.analyseGame(`alternatives:${source.epd}:${position.epd}`, [{ moves: position.moves, tier: "owner", played: [] }], {
          priority: "interactive",
          onResult: (_slot, result) => {
            putPositionEval(deps.db, deps.configId, result);
            cost.nodes.onlyMoves += result.nodes;
            cost.searched += 1;
            done += 1;
            onProgress?.(done, missing.length, `Checking the sample lines for only-moves: ${done} of ${missing.length}`);
          }
        })
      )
    );
  }
  const result = missing.length ? rankWith(source, deep, refreshLookup(), deps.db, deps.configId) : first;
  cost.ms = Math.round(performance.now() - started);
  return { result, cost };
}

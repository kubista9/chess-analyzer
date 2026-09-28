import { analyzeGameOpening, type EvalLookup, type GameOpeningAnalysis } from "../../shared/openingAnalysis.js";
import type { OpeningBook } from "../../shared/openingBook.js";
import type { TreeGame } from "../../shared/openingTree.js";
import type { EngineTier, PositionEval } from "../../shared/types.js";
import type { Db } from "../db/connection.js";
import { listPositionEvals, positionsStamp } from "../db/positions.js";

// The position cache in memory for one engine config, and the per-game opening analyses over it.
// Rows are loaded incrementally (only those written since the last load), so polling during a
// running backfill stays cheap. The cache generation (row count + newest analyzed_at) keys the
// per-game memo: a new or upgraded row recomputes the analyses, nothing else does.

export interface EngineView {
  configId: number;
  /** Changes whenever a position row is added or upgraded. */
  generation: string;
  lookup: EvalLookup;
  /** The game's opening analysis at the tree's window, memoised by game id and generation. */
  analysisOf: (game: TreeGame) => GameOpeningAnalysis;
  /** Stored positions in memory. */
  positions: number;
}

interface ConfigState {
  rows: Map<string, PositionEval>;
  count: number;
  lastAt: number;
  generation: string;
  memo: Map<string, GameOpeningAnalysis>;
  view: EngineView;
}

export function createAnalysisIndex(deps: { book: () => OpeningBook; maxPly: number }) {
  const states = new Map<number, ConfigState>();

  /** The engine view of `configId`, refreshed from the store if any row changed. */
  function view(db: Db, configId: number): EngineView {
    let state = states.get(configId);
    const stamp = positionsStamp(db, configId);
    if (state && state.count === stamp.count && state.lastAt === stamp.lastAt) {
      return state.view;
    }
    if (!state) {
      state = createState(configId);
      states.set(configId, state);
    }
    // >= the last load's newest row: rows written in that same millisecond are read again (idempotent).
    for (const evaluation of listPositionEvals(db, configId, state.lastAt)) {
      state.rows.set(`${evaluation.tier}|${evaluation.epd}`, evaluation);
    }
    state.count = stamp.count;
    state.lastAt = stamp.lastAt;
    state.generation = `${configId}:${stamp.count}:${stamp.lastAt}`;
    state.memo.clear();
    state.view = { ...state.view, generation: state.generation, positions: state.rows.size };
    return state.view;
  }

  function createState(configId: number): ConfigState {
    const rows = new Map<string, PositionEval>();
    const memo = new Map<string, GameOpeningAnalysis>();
    // The best tier present, as getPositionEval: an owner-tier row answers an opponent request.
    const lookup: EvalLookup = (epd: string, tier: EngineTier) =>
      rows.get(`owner|${epd}`) ?? (tier === "opponent" ? rows.get(`opponent|${epd}`) : undefined);
    const analysisOf = (game: TreeGame) => {
      const key = `${game.id}|${game.color}`;
      let analysis = memo.get(key);
      if (!analysis) {
        analysis = analyzeGameOpening(game, lookup, deps.book(), deps.maxPly);
        memo.set(key, analysis);
      }
      return analysis;
    };
    const state: ConfigState = {
      rows,
      count: -1,
      lastAt: 0,
      generation: "",
      memo,
      view: { configId, generation: "", lookup, analysisOf, positions: 0 }
    };
    return state;
  }

  return { view, clear: () => states.clear() };
}

export type AnalysisIndex = ReturnType<typeof createAnalysisIndex>;

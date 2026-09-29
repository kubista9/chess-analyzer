import { Chess } from "chess.js";
import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import { rootMoveLoss } from "../../shared/eval.js";
import type { OpeningBook } from "../../shared/openingBook.js";
import type { OpeningTree, TreeGame } from "../../shared/openingTree.js";
import type {
  DrillAnswerRequest,
  DrillAnswerResponse,
  DrillCardView,
  DrillCounts,
  DrillFilter,
  DrillSessionResponse,
  DrillStats,
  LineRunItem,
  MistakeItem,
  SessionItem
} from "../../shared/training/api.js";
import {
  buildRepGraph,
  generateCards,
  mergeCards,
  type DeepCheck,
  type MistakeOccurrence,
  type RepGraph,
  type StoredCard
} from "../../shared/training/cards.js";
import { SOUND_LOSS, acceptableMoves, gradesSchedule, judgeLineMove, judgeMistakeMove, outcomeOf, type DrillVerdict } from "../../shared/training/judge.js";
import { planLineRuns, seededRng } from "../../shared/training/lineDrill.js";
import {
  DAY_MS,
  DRILL_KINDS,
  grade,
  hash32,
  introduce,
  isDue,
  newSlots,
  sessionPriority,
  startOfDay,
  type DrillKind
} from "../../shared/training/scheduler.js";
import type { JobState, PlayerColor, PositionEval, SearchTier } from "../../shared/types.js";
import type { Db } from "../db/connection.js";
import { countReviewsSince, getCard, getMeta, insertReview, listCards, putCards, putConfirm, putSrs, setMeta } from "../db/drills.js";
import { gamesStamp, getGame } from "../db/games.js";
import { getDeepEval, getPositionEval, putPositionEval } from "../db/positions.js";
import { getRepEntry, repertoireStamp } from "../db/repertoire.js";
import { lineFor } from "../engine/analysePosition.js";
import type { EnginePool } from "../engine/pool.js";
import type { JobStore } from "../store/jobStore.js";
import type { EngineView } from "./analysisIndex.js";
import { isAnswered } from "./openingPass.js";
import { loadRepertoire } from "./repertoireService.js";
import { fenOf, toReviewLine } from "./review.js";
import { DEFAULT_HALF_LIFE_BY_WINDOW, type BuiltTree, type TreeService } from "./treeService.js";

// Drills over the store. Cards are regenerated lazily: whenever the games, the owner-tier
// cache, the repertoire or the day changed since the last generation (so after a sync, a
// backfill and a repertoire edit), the next drills request rebuilds and merges them. Mistake
// cards get their deep-tier check only when they are about to be introduced (today's new-card
// slots), as one background job.

/** A first owner error: loss >= 5 win% (inaccuracy or worse). */
export const MISTAKE_MIN_LOSS = SOUND_LOSS;
/** Mistake candidates checked per new slot (some are cleared by the deep check). */
const CHECK_EXTRA = 2;
/** Line runs per session, and mistake positions per session. */
export const SESSION_MAX_RUNS = 6;
export const SESSION_MAX_MISTAKES = 20;
/** A card from an entry edited this recently skips the new-card cap (an adopted alternative drills at once). */
const FRESH_EDIT_MS = DAY_MS;
const DRILL_WINDOW = "6m" as const;

export class DrillInputError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface DrillDeps {
  db: () => Db;
  owner: string;
  trees: TreeService;
  book: () => OpeningBook;
  engineView: () => Promise<EngineView | null>;
  pool: () => Pick<EnginePool, "analyseGame">;
  jobs: JobStore;
}

const counts = (): DrillCounts => ({ "repertoire-line": 0, "own-mistake": 0 });

/** Each game's first owner error (loss >= 5 in the first 20 plies), where every earlier owner move is scored. */
export function firstErrors(db: Db, games: readonly TreeGame[], engine: Pick<EngineView, "analysisOf">): MistakeOccurrence[] {
  const out: MistakeOccurrence[] = [];
  for (const game of games) {
    const analysis = engine.analysisOf(game);
    for (const move of analysis.ownerMoves) {
      if (move.status === "pending") {
        break;
      }
      if (move.ply > OPENING_PLY_LIMIT) {
        break;
      }
      if (move.loss < MISTAKE_MIN_LOSS) {
        continue;
      }
      out.push(occurrenceOf(db, game, move.ply, move.uci, move.san, move.epdBefore, move.loss));
      break;
    }
  }
  return out;
}

function occurrenceOf(db: Db, game: TreeGame, ply: number, uci: string, san: string, epd: string, loss: number): MistakeOccurrence {
  const record = getGame(db, game.id);
  const path = game.plies.slice(0, ply - 1);
  return {
    color: game.color,
    epd,
    pathUci: path.map((step) => step.uci),
    pathSan: path.map((step) => step.san),
    gameId: game.id,
    endTime: game.endTime,
    opponent: record?.oppName ?? "?",
    oppRating: game.oppRating,
    ply,
    playedUci: uci,
    playedSan: san,
    loss: Math.round(loss * 100) / 100
  };
}

function moverOf(ply: number): PlayerColor {
  return ply % 2 === 1 ? "white" : "black";
}

export function createDrillService(deps: DrillDeps) {
  let graphMemo: { key: string; graphs: Record<PlayerColor, RepGraph> } | null = null;

  const builtTrees = (nowMs: number): Record<PlayerColor, BuiltTree> => {
    const filters = { window: DRILL_WINDOW, timeClass: null, halfLifeDays: DEFAULT_HALF_LIFE_BY_WINDOW[DRILL_WINDOW] };
    return {
      white: deps.trees.getTree({ color: "white", ...filters }, nowMs),
      black: deps.trees.getTree({ color: "black", ...filters }, nowMs)
    };
  };

  const graphsFor = (db: Db): Record<PlayerColor, RepGraph> => {
    const key = repertoireStamp(db, deps.owner);
    if (graphMemo?.key !== key) {
      const entries = loadRepertoire(db, deps.owner);
      graphMemo = { key, graphs: { white: buildRepGraph("white", entries.white), black: buildRepGraph("black", entries.black) } };
    }
    return graphMemo.graphs;
  };

  /** Regenerates the cards when their inputs changed (or always with `force`). Returns the merge counts, or null when nothing changed. */
  async function regenerate(nowMs: number, force = false) {
    const db = deps.db();
    const engine = await deps.engineView();
    const stamp = [gamesStamp(db, deps.owner), engine?.generation ?? "none", repertoireStamp(db, deps.owner), startOfDay(nowMs)].join("#");
    if (!force && getMeta(db, deps.owner, "cards-stamp") === stamp) {
      return null;
    }
    const built = builtTrees(nowMs);
    const graphs = graphsFor(db);
    const occurrences = engine ? [...firstErrors(db, built.white.games, engine), ...firstErrors(db, built.black.games, engine)] : [];
    const trees: Record<PlayerColor, OpeningTree> = { white: built.white.tree, black: built.black.tree };
    const drafts = generateCards({
      graphs,
      occurrences,
      nodeWeight: (color, epd) => trees[color].nodes.get(epd)?.wN ?? 0,
      book: deps.book(),
      now: built.white.tree.now,
      halfLifeDays: built.white.tree.halfLifeDays
    });
    const merge = mergeCards(listCards(db, deps.owner), drafts, nowMs);
    putCards(db, deps.owner, merge.write);
    setMeta(db, deps.owner, "cards-stamp", stamp);
    return { added: merge.added, removed: merge.removed, restored: merge.restored, recurred: merge.recurred, written: merge.write.length };
  }

  const visible = (card: StoredCard) => card.status === "active" && !card.srs.retired && (card.kind === "repertoire-line" || card.confirm !== "rejected");

  const view = (card: StoredCard, nowMs: number): DrillCardView => ({
    id: card.id,
    kind: card.kind,
    color: card.color,
    epd: card.epd,
    fen: fenOf(card.epd, card.ply),
    ply: card.ply,
    pathUci: card.pathUci,
    pathSan: card.pathSan,
    lineName: card.lineName,
    eco: card.eco,
    primary: card.kind === "repertoire-line" ? card.primary : null,
    box: card.srs.box,
    dueAt: card.srs.dueAt,
    lapses: card.srs.lapses,
    reviews: card.srs.reviews,
    isNew: card.srs.introducedAt !== null && card.srs.introducedAt >= startOfDay(nowMs),
    weight: card.weight,
    sources: card.sources.slice(0, 5),
    sourceCount: card.sources.length
  });

  const introducedToday = (cards: readonly StoredCard[], kind: DrillKind, nowMs: number) =>
    cards.filter((card) => card.kind === kind && card.srs.introducedAt !== null && card.srs.introducedAt >= startOfDay(nowMs)).length;

  /** Introduces today's new line cards (cap, fresh edits first) and today's confirmed mistake cards. Returns the mistake candidates still to check. */
  function introduceNew(db: Db, nowMs: number, focus: StoredCard | null): StoredCard[] {
    const cards = listCards(db, deps.owner).filter(visible);
    const lineNew = cards
      .filter((card) => card.kind === "repertoire-line" && card.srs.box === 0)
      .map((card) => {
        // Only the owner's own edits (an adopted alternative, Set as my move) skip the cap; a seed does not.
        const entry = getRepEntry(db, deps.owner, card.color, card.epd);
        return { card, fresh: entry?.source === "edited" && nowMs - entry.updatedAt < FRESH_EDIT_MS };
      })
      .filter((item) => item.card.primary);
    // Fresh edits first, then the most-reached positions (a child is never reached more than its
    // parent, so the lines are learnt from move 1 down).
    lineNew.sort(
      (left, right) =>
        Number(right.fresh) - Number(left.fresh) || right.card.weight - left.card.weight || left.card.ply - right.card.ply || left.card.id.localeCompare(right.card.id)
    );
    let lineSlots = newSlots("repertoire-line", introducedToday(cards, "repertoire-line", nowMs));
    for (const { card, fresh } of lineNew) {
      const isFocus = focus?.id === card.id;
      if (!fresh && !isFocus && lineSlots <= 0) {
        continue;
      }
      if (!fresh && !isFocus) {
        lineSlots -= 1;
      }
      putSrs(db, deps.owner, card.id, introduce(card.srs, nowMs));
    }

    const mistakeNew = cards
      .filter((card) => card.kind === "own-mistake" && card.srs.box === 0)
      .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id));
    let slots = newSlots("own-mistake", introducedToday(cards, "own-mistake", nowMs));
    const toCheck: StoredCard[] = [];
    const focusMistake = focus?.kind === "own-mistake" && focus.srs.box === 0 ? focus : null;
    for (const card of focusMistake ? [focusMistake, ...mistakeNew.filter((item) => item.id !== focusMistake.id)] : mistakeNew) {
      const isFocus = card.id === focusMistake?.id;
      if (slots <= 0 && !isFocus) {
        break;
      }
      if (card.confirm === "confirmed") {
        putSrs(db, deps.owner, card.id, introduce(card.srs, nowMs));
        slots -= isFocus ? 0 : 1;
        continue;
      }
      // Pending: the cached deep row may already settle it.
      const settled = confirmFromCache(db, card, nowMs);
      if (settled === "confirmed") {
        putSrs(db, deps.owner, card.id, introduce(card.srs, nowMs));
        slots -= isFocus ? 0 : 1;
      } else if (settled === null && (isFocus || toCheck.length < slots + CHECK_EXTRA)) {
        toCheck.push(card);
      }
    }
    return toCheck;
  }

  const configIdOf = async () => (await deps.engineView())?.configId ?? null;
  let configIdCache: number | null = null;

  /** The deep check from a cached deep row that scores every source move; null when a search is needed. */
  function confirmFromCache(db: Db, card: StoredCard, nowMs: number): "confirmed" | "rejected" | null {
    if (configIdCache === null) {
      return null;
    }
    const deep = getDeepEval(db, configIdCache, card.epd);
    const played = [...new Set(card.sources.map((source) => source.playedUci))];
    if (!deep || !isAnswered(deep, played)) {
      return null;
    }
    return settleCheck(db, card, deep, played, nowMs);
  }

  function settleCheck(db: Db, card: StoredCard, deep: PositionEval, played: readonly string[], nowMs: number): "confirmed" | "rejected" {
    const best = deep.lines[0];
    if (!best) {
      putConfirm(db, deps.owner, card.id, "rejected", null);
      return "rejected";
    }
    const losses = played.map((uci) => {
      const line = lineFor(deep, uci);
      return line ? rootMoveLoss(best, line) : 0;
    });
    const worstLoss = Math.round(Math.max(0, ...losses) * 100) / 100;
    const check: DeepCheck = { bestUci: best.uci, bestSan: sanAt(card, best.uci), worstLoss, depth: deep.depth, checkedAt: nowMs };
    const confirm = worstLoss >= MISTAKE_MIN_LOSS ? "confirmed" : "rejected";
    putConfirm(db, deps.owner, card.id, confirm, check);
    return confirm;
  }

  const sanAt = (card: StoredCard, uci: string): string => {
    try {
      return new Chess(fenOf(card.epd, card.ply)).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
    } catch {
      return uci;
    }
  };

  /** Starts (or joins) the deep check of `cards` as one job; each confirmed card is introduced if today's slots allow. */
  function startCheck(cards: readonly StoredCard[], nowMs: number, focusId: string | null): JobState<DrillStats> | null {
    if (!cards.length || configIdCache === null) {
      return null;
    }
    const configId = configIdCache;
    const { job } = deps.jobs.startOrReuse<DrillStats>("drills:check", "drill-check", "Checking new positions", async (reporter) => {
      const db = deps.db();
      reporter.progress(3, `Deep engine check of ${cards.length} new position${cards.length === 1 ? "" : "s"}`);
      let done = 0;
      const played = cards.map((card) => [...new Set(card.sources.map((source) => source.playedUci))]);
      await deps.pool().analyseGame(
        "drills:check",
        cards.map((card, index) => ({ moves: card.pathUci, tier: "deep" as const, played: played[index], cached: getDeepEval(db, configId, card.epd) ?? null })),
        {
          priority: "interactive",
          onResult: (slot, evaluation) => {
            putPositionEval(db, configId, evaluation);
            const card = cards[slot];
            const verdict = settleCheck(db, card, evaluation, played[slot], nowMs);
            const current = listCards(db, deps.owner);
            if (verdict === "confirmed" && (card.id === focusId || newSlots("own-mistake", introducedToday(current, "own-mistake", nowMs)) > 0)) {
              const fresh = getCard(db, deps.owner, card.id);
              if (fresh && fresh.srs.box === 0) {
                putSrs(db, deps.owner, card.id, introduce(fresh.srs, nowMs));
              }
            }
            done += 1;
            reporter.progress(5 + (done / cards.length) * 90, `Deep engine check: ${done} of ${cards.length}`);
          }
        }
      );
      return stats(nowMs);
    });
    return job;
  }

  function computeStats(db: Db, nowMs: number, engine: EngineView | null): DrillStats {
    const all = listCards(db, deps.owner);
    const cards = all.filter(visible);
    const due = counts();
    const fresh = counts();
    const total = counts();
    let nextDueAt: number | null = null;
    for (const card of cards) {
      if (card.kind === "own-mistake" && card.confirm !== "confirmed") {
        continue;
      }
      total[card.kind] += 1;
      if (isDue(card.srs, nowMs)) {
        due[card.kind] += 1;
        if (card.srs.introducedAt !== null && card.srs.introducedAt >= startOfDay(nowMs) && card.srs.reviews === 0) {
          fresh[card.kind] += 1;
        }
      } else if (card.srs.dueAt !== null && card.srs.box > 0 && (nextDueAt === null || card.srs.dueAt < nextDueAt)) {
        nextDueAt = card.srs.dueAt;
      }
    }
    const reviewedToday = { "repertoire-line": { correct: 0, wrong: 0 }, "own-mistake": { correct: 0, wrong: 0 } };
    for (const row of countReviewsSince(db, deps.owner, startOfDay(nowMs))) {
      reviewedToday[row.kind] = { correct: row.correct, wrong: row.wrong };
    }
    const entries = loadRepertoire(db, deps.owner);
    const built = builtTrees(nowMs);
    const analysedGames = engine
      ? [...built.white.games, ...built.black.games].filter((game) => engine.analysisOf(game).status === "complete").length
      : 0;
    return {
      due,
      fresh,
      total,
      retired: all.filter((card) => card.status === "active" && card.srs.retired).length,
      unchecked: cards.filter((card) => card.kind === "own-mistake" && card.confirm === "pending").length,
      reviewedToday,
      repertoireEntries: entries.white.size + entries.black.size,
      analysedGames,
      engine: engine !== null,
      nextDueAt
    };
  }

  async function stats(nowMs: number): Promise<DrillStats> {
    await regenerate(nowMs);
    const engine = await deps.engineView();
    configIdCache = engine?.configId ?? null;
    const db = deps.db();
    // Counting includes the new cards today's cap lets in, so introduce them first. The deep
    // check of new mistake cards starts only with a session (the Train page), never from a count.
    introduceNew(db, nowMs, null);
    return computeStats(db, nowMs, engine);
  }

  /** The card for a Train link: an id, or a (colour, position) with whichever kind holds it. */
  function findCard(db: Db, focus: { id?: string; color?: PlayerColor; epd?: string }): StoredCard | undefined {
    if (focus.id) {
      return getCard(db, deps.owner, focus.id);
    }
    return listCards(db, deps.owner).find((card) => card.color === focus.color && card.epd === focus.epd && card.status === "active");
  }

  async function session(
    nowMs: number,
    options: { kind: DrillFilter; focus?: { id?: string; color?: PlayerColor; epd?: string } }
  ): Promise<DrillSessionResponse> {
    await regenerate(nowMs);
    const engine = await deps.engineView();
    configIdCache = engine?.configId ?? null;
    const db = deps.db();
    let focusNote: string | null = null;
    let focus: StoredCard | null = null;
    if (options.focus && (options.focus.id || options.focus.epd)) {
      focus = findCard(db, options.focus) ?? null;
      if (!focus) {
        focusNote = "There is no drill for this position yet: give it a repertoire move, or it becomes one once a game of yours goes wrong there.";
      } else if (focus.kind === "own-mistake" && focus.confirm === "rejected") {
        focusNote = "The deep engine check found no real mistake here, so this position is not drilled.";
        focus = null;
      } else if (focus.srs.retired) {
        focusNote = "You have learned this position; it comes back if the mistake recurs.";
        focus = null;
      }
    }
    const toCheck = introduceNew(db, nowMs, focus);
    // A lines-only session does not start the deep check of new positions from the games.
    const job = options.kind === "repertoire-line" && focus?.kind !== "own-mistake" ? null : startCheck(toCheck, nowMs, focus?.id ?? null);
    if (focus?.kind === "own-mistake" && toCheck.some((card) => card.id === focus!.id)) {
      focusNote = "Checking this position with the engine first.";
    }

    const cards = listCards(db, deps.owner).filter(visible);
    const focusId = focus?.id ?? null;
    const dueOf = (kind: DrillKind) =>
      cards
        .filter((card) => card.kind === kind && (kind === "repertoire-line" || card.confirm === "confirmed") && (isDue(card.srs, nowMs) || card.id === focusId))
        .map((card) => ({ card, priority: card.id === focusId ? Number.POSITIVE_INFINITY : sessionPriority(kind, card.srs, card.weight, nowMs) }))
        .sort((left, right) => right.priority - left.priority || left.card.id.localeCompare(right.card.id))
        .map((item) => item.card);

    const lineItems: LineRunItem[] = [];
    if (options.kind !== "own-mistake") {
      const graphs = graphsFor(db);
      const built = builtTrees(nowMs);
      for (const color of ["white", "black"] as const) {
        const due = dueOf("repertoire-line").filter((card) => card.color === color);
        if (!due.length) {
          continue;
        }
        const byEpd = new Map(due.map((card) => [card.epd, card]));
        const tree = built[color].tree;
        const runs = planLineRuns(
          graphs[color],
          new Set(byEpd.keys()),
          {
            rng: seededRng(hash32(`${startOfDay(nowMs)}|${color}|${due.length}`)),
            replyWeight: (epd, uci) => tree.nodes.get(epd)?.edges.find((edge) => edge.uci === uci)?.weighted.wN ?? 0,
            book: deps.book()
          },
          SESSION_MAX_RUNS
        );
        for (const [index, run] of runs.entries()) {
          const graded = Object.fromEntries(
            run.steps.filter((step) => step.graded).map((step) => [step.epd, view(byEpd.get(step.epd)!, nowMs)])
          );
          const lastOwner = [...run.steps].reverse().find((step) => step.mover === "owner");
          const last = lastOwner ? byEpd.get(lastOwner.epd) ?? cards.find((card) => card.id === `repertoire-line|${color}|${lastOwner.epd}`) : undefined;
          lineItems.push({
            type: "line-run",
            key: `line|${color}|${index}`,
            color,
            lineName: last?.lineName ?? null,
            eco: last?.eco ?? null,
            steps: run.steps,
            cards: graded
          });
        }
      }
      if (focus?.kind === "repertoire-line") {
        // The focused card first.
        lineItems.sort((left, right) => Number(focus!.epd in right.cards) - Number(focus!.epd in left.cards));
      }
    }
    const mistakeItems: MistakeItem[] =
      options.kind === "repertoire-line"
        ? []
        : dueOf("own-mistake")
            .slice(0, SESSION_MAX_MISTAKES)
            .map((card) => ({ type: "mistake", key: `mistake|${card.id}`, card: view(card, nowMs) }));

    const items: SessionItem[] = [];
    if (focus?.kind === "own-mistake") {
      const index = mistakeItems.findIndex((item) => item.card.id === focus!.id);
      if (index >= 0) {
        items.push(...mistakeItems.splice(index, 1));
      }
    }
    // Mixed: alternate one line run and two positions.
    while (lineItems.length || mistakeItems.length) {
      if (lineItems.length) {
        items.push(lineItems.shift()!);
      }
      items.push(...mistakeItems.splice(0, 2));
    }
    return { items, stats: computeStats(db, nowMs, engine), job, focusNote };
  }

  /** The eval at a card's root that scores `uci`: a cached row, else a depth-matched searchmoves follow-up. */
  async function scoredEval(db: Db, card: StoredCard, uci: string, tier: SearchTier): Promise<{ evaluation: PositionEval; searched: boolean } | null> {
    const configId = await configIdOf();
    if (configId === null) {
      return null;
    }
    const cached = tier === "deep" ? getDeepEval(db, configId, card.epd) : getPositionEval(db, configId, card.epd, tier);
    if (cached && isAnswered(cached, [uci])) {
      return { evaluation: cached, searched: false };
    }
    const [evaluation] = await deps.pool().analyseGame(`drill:${card.id}`, [{ moves: card.pathUci, tier, played: [uci], cached: cached ?? null }], {
      priority: "interactive",
      onResult: (_slot, result) => putPositionEval(db, configId, result)
    });
    return { evaluation, searched: true };
  }

  async function answer(nowMs: number, request: DrillAnswerRequest): Promise<DrillAnswerResponse> {
    const db = deps.db();
    const card = getCard(db, deps.owner, request.id);
    if (!card || card.status !== "active") {
      throw new DrillInputError(404, "This drill no longer exists (the repertoire or the games changed). Reload the session.");
    }
    const fen = fenOf(card.epd, card.ply);
    let san: string;
    try {
      san = new Chess(fen).move({ from: request.uci.slice(0, 2), to: request.uci.slice(2, 4), promotion: request.uci[4] }).san;
    } catch {
      throw new DrillInputError(400, `${request.uci} is not a legal move in this position.`);
    }
    const mover = moverOf(card.ply);
    const entry = getRepEntry(db, deps.owner, card.color, card.epd);
    const repertoire = entry ? { uci: entry.uci, san: entry.san } : null;

    let verdict: DrillVerdict;
    let loss: number | null = null;
    let searched = false;
    let best = null;
    let played = null;
    let acceptable: DrillAnswerResponse["acceptable"] = [];

    if (card.kind === "repertoire-line") {
      if (!entry) {
        throw new DrillInputError(409, "This position has no repertoire move any more. Reload the session.");
      }
      if (request.uci !== entry.uci) {
        // Soundness from the deep row when it already scores the move, else the owner tier.
        const configId = await configIdOf();
        const deep = configId !== null ? getDeepEval(db, configId, card.epd) : undefined;
        const scored = deep && isAnswered(deep, [request.uci]) ? { evaluation: deep, searched: false } : await scoredEval(db, card, request.uci, "owner");
        if (scored?.evaluation.lines[0]) {
          const line = lineFor(scored.evaluation, request.uci);
          loss = line ? Math.round(rootMoveLoss(scored.evaluation.lines[0], line) * 100) / 100 : null;
          best = toReviewLine(fen, scored.evaluation.lines[0], mover);
          played = line ? toReviewLine(fen, line, mover) : null;
          searched = scored.searched;
        }
      }
      verdict = judgeLineMove(entry.uci, request.uci, loss);
    } else {
      const scored = await scoredEval(db, card, request.uci, "deep");
      if (!scored || !scored.evaluation.lines[0]) {
        throw new DrillInputError(503, "Stockfish is not available to judge this position.");
      }
      const { evaluation } = scored;
      searched = scored.searched;
      const top = evaluation.lines[0];
      const line = lineFor(evaluation, request.uci)!;
      loss = Math.round(rootMoveLoss(top, line) * 100) / 100;
      verdict = judgeMistakeMove({ uci: request.uci, loss, repertoireUci: entry?.uci ?? null });
      const scoredMoves = [...evaluation.lines, ...evaluation.scored].map((item) => ({
        uci: item.uci,
        san: sanAt(card, item.uci),
        loss: Math.round(rootMoveLoss(top, item) * 100) / 100
      }));
      acceptable = acceptableMoves(
        scoredMoves.filter((item, index) => scoredMoves.findIndex((other) => other.uci === item.uci) === index),
        entry ? { uci: entry.uci } : null
      );
      best = toReviewLine(fen, top, mover);
      played = toReviewLine(fen, line, mover);
    }

    const graded = gradesSchedule(verdict, request.attempts);
    const outcome = outcomeOf(verdict);
    const srs = graded && outcome ? grade(card.kind, card.id, card.srs, outcome, nowMs) : card.srs;
    if (graded) {
      putSrs(db, deps.owner, card.id, srs);
    }
    insertReview(db, deps.owner, {
      cardId: card.id,
      kind: card.kind,
      reviewedAt: nowMs,
      uci: request.uci,
      san,
      verdict,
      loss,
      graded,
      attempts: request.attempts,
      ms: request.ms ?? null,
      boxBefore: card.srs.box,
      boxAfter: srs.box,
      dueAfter: srs.dueAt
    });
    return {
      id: card.id,
      kind: card.kind,
      uci: request.uci,
      san,
      verdict,
      correct: outcome === "correct",
      graded,
      loss,
      repertoire,
      acceptable,
      best,
      played,
      box: srs.box,
      nextDue: srs.dueAt,
      retired: srs.retired,
      searched
    };
  }

  return { regenerate, stats, session, answer, kinds: DRILL_KINDS };
}

export type DrillService = ReturnType<typeof createDrillService>;

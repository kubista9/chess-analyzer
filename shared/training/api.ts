import type { JobState, PlayerColor, ReviewLine } from "../types.js";
import type { MistakeSource } from "./cards.js";
import type { AcceptableMove, DrillVerdict } from "./judge.js";
import type { LineStep } from "./lineDrill.js";
import type { DrillKind } from "./scheduler.js";

// The drill API's DTOs (server and client).

export type DrillFilter = "all" | DrillKind;

export interface DrillCardView {
  id: string;
  kind: DrillKind;
  color: PlayerColor;
  epd: string;
  /** The position as a full FEN (move number from the ply). */
  fen: string;
  /** The ply of the owner's move to find. */
  ply: number;
  pathUci: string[];
  pathSan: string[];
  lineName: string | null;
  eco: string | null;
  /** Line cards: the repertoire move. Mistake cards: null (revealed by the answer). */
  primary: { uci: string; san: string } | null;
  box: number;
  dueAt: number | null;
  lapses: number;
  reviews: number;
  /** Introduced today. */
  isNew: boolean;
  weight: number;
  /** Mistake cards: the games behind it; line cards: the games you went wrong here. Newest first, at most 5. */
  sources: MistakeSource[];
  sourceCount: number;
}

export interface LineRunItem {
  type: "line-run";
  key: string;
  color: PlayerColor;
  /** The book name at the end of the run. */
  lineName: string | null;
  eco: string | null;
  steps: LineStep[];
  /** The graded steps' cards, by EPD. */
  cards: Record<string, DrillCardView>;
}

export interface MistakeItem {
  type: "mistake";
  key: string;
  card: DrillCardView;
}

export type SessionItem = LineRunItem | MistakeItem;

export interface DrillCounts {
  "repertoire-line": number;
  "own-mistake": number;
}

export interface DrillStats {
  /** Due now, including the new cards today's cap still lets in (and that are ready). */
  due: DrillCounts;
  /** Of which new today. */
  fresh: DrillCounts;
  /** Active cards (not removed, not retired; mistake cards only once confirmed). */
  total: DrillCounts;
  retired: number;
  /** Mistake cards waiting for their deep check. */
  unchecked: number;
  reviewedToday: Record<DrillKind, { correct: number; wrong: number }>;
  repertoireEntries: number;
  /** Games of the window with a complete opening analysis. */
  analysedGames: number;
  engine: boolean;
  /** The next due time (ms) after now, or null. */
  nextDueAt: number | null;
}

export interface DrillSessionResponse {
  items: SessionItem[];
  stats: DrillStats;
  /** The deep check of today's new mistake cards, while it runs. */
  job: JobState<DrillStats> | null;
  /** Why a requested card (focus) is not in the session, or null. */
  focusNote: string | null;
}

export interface DrillAnswerRequest {
  id: string;
  uci: string;
  /** Think time in ms. */
  ms?: number;
  /** 1 for the first graded try at the card in this presentation. */
  attempts: number;
}

export interface DrillAnswerResponse {
  id: string;
  kind: DrillKind;
  uci: string;
  san: string;
  verdict: DrillVerdict;
  correct: boolean;
  /** The answer changed the card's schedule. */
  graded: boolean;
  /** The move's win% loss against the best at this root, or null when unknown. */
  loss: number | null;
  /** The repertoire move at this position (line cards; mistake cards when one exists). */
  repertoire: { uci: string; san: string } | null;
  /** Mistake cards: the accepted moves. */
  acceptable: AcceptableMove[];
  best: ReviewLine | null;
  played: ReviewLine | null;
  box: number;
  nextDue: number | null;
  retired: boolean;
  /** The engine searched the move now. */
  searched: boolean;
}

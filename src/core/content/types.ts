import type { AppliedMove, Color } from "../chess/position";
import type { Checkpoint, Idea, KnownMistake, Alternative, Priority, ReviewMeta, SourceMeta, Trap } from "./schema";

// The content after compilation: every line replayed with chess.js, notes resolved to positions,
// and the repertoire turned into a position graph per side. Built once at start-up (and again
// when the user adds or edits a line of their own).

export type Origin = "builtin" | "custom";

export interface Chapter {
  id: string;
  side: Color;
  group: string;
  family: string;
  chapter: string;
  order: number;
  summary: string;
  ideas: string[];
  source: SourceMeta;
  review: ReviewMeta;
  origin: Origin;
  /** In file order. */
  lineIds: string[];
}

export interface CompiledTrap extends Trap {
  sans: string[];
  /** The trap's moves replayed (Trap.moves keeps the movetext as written). */
  played: AppliedMove[];
}

export interface Line {
  id: string;
  chapterId: string;
  side: Color;
  group: string;
  family: string;
  chapter: string;
  name: string;
  eco: string | null;
  priority: Priority;
  defaultEnabled: boolean;
  description: string;
  plans: string[];
  ideas: string[];
  traps: CompiledTrap[];
  checkpoints: Checkpoint[];
  /** SAN as replayed by chess.js (canonical spelling, check marks included). */
  sans: string[];
  moves: AppliedMove[];
  /** epds[i] is the position before ply i + 1; the last entry is the final position (length = plies + 1). */
  epds: string[];
  finalFen: string;
  /** Plies shown in Position Recall (1..plies). */
  recallPly: number;
  /** 1-based plies the user plays (odd plies for White, even for Black). */
  userPlies: number[];
  source: SourceMeta;
  review: ReviewMeta;
  origin: Origin;
  /** A global teaching order: chapter order, then line order within the chapter. */
  order: number;
}

/** A move note bound to the position it annotates. */
export interface CompiledNote {
  /** The path key it was written under, e.g. "c4 e5 Nc3". */
  key: string;
  chapterId: string;
  epdBefore: string;
  uci: string;
  san: string;
  /** The colour that plays the annotated move. */
  mover: Color;
  idea: Idea | null;
  hint: string | null;
  narrow: string | null;
  why: string;
  fits: string | null;
  avoids: string | null;
  alternatives: Alternative[];
  mistakes: KnownMistake[];
}

export interface ContentIssue {
  level: "error" | "warning";
  /** Chapter (file) id, when known. */
  fileId?: string;
  lineId?: string;
  /** The note key or field the issue is about. */
  path?: string;
  message: string;
}

export interface Catalog {
  chapters: Chapter[];
  lines: Line[];
  chapterById: Map<string, Chapter>;
  lineById: Map<string, Line>;
  /** Notes by `${epdBefore}|${uci}` (the first chapter in order wins on a duplicate). */
  notes: Map<string, CompiledNote>;
  /** Problems found while compiling; lines with errors are left out of `lines`. */
  issues: ContentIssue[];
}

/** One move of the repertoire graph. */
export interface TreeEdge {
  uci: string;
  san: string;
  from: string;
  to: string;
  mover: "user" | "opponent";
  /** Enabled lines that play this move here, in teaching order. */
  lineIds: string[];
  /** The best priority among those lines. */
  priority: Priority;
}

export interface TreeNode {
  epd: string;
  fen: string;
  toMove: Color;
  userToMove: boolean;
  /** Fewest plies from the start along any enabled line. */
  minPly: number;
  /** SAN path of that shortest route (for context such as "after 1.c4 e5 2.Nc3"). */
  pathSans: string[];
  /** Out of this position, ordered by priority, then teaching order. */
  edges: TreeEdge[];
  /** Enabled lines that pass through this position, in teaching order. */
  lineIds: string[];
}

/** The enabled repertoire of one side as a position graph (transpositions share a node). */
export interface RepertoireTree {
  side: Color;
  nodes: Map<string, TreeNode>;
  /** The enabled lines the tree was built from. */
  lineIds: Set<string>;
}

/** A position where the user must find their repertoire move: the unit of spaced review. */
export interface PositionItem {
  /** posKey(side, epd). */
  key: string;
  side: Color;
  epd: string;
  fen: string;
  /** The user's repertoire moves here (usually one; more when several enabled lines differ). */
  expected: TreeEdge[];
  lineIds: string[];
  minPly: number;
  pathSans: string[];
  priority: Priority;
  /** Teaching order: the order of its first line, then its ply. */
  order: number;
}

/** The storage key of a position item. */
export function posKey(side: Color, epd: string): string {
  return `${side}|${epd}`;
}

/** Index key for notes and edges. */
export function moveKey(epdBefore: string, uci: string): string {
  return `${epdBefore}|${uci}`;
}

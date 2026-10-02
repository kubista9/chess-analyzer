import { parseMovetext } from "../chess/format";
import { START_EPD, START_FEN, fenOf, replayMoves, type AppliedMove, type Color } from "../chess/position";
import { PRIORITIES, type Idea, type Priority } from "../content/schema";
import {
  moveKey,
  posKey,
  type Catalog,
  type Chapter,
  type CompiledNote,
  type Line,
  type PositionItem,
  type RepertoireTree,
  type TreeEdge,
  type TreeNode
} from "../content/types";
import { newSrs } from "./scheduler";
import type { AttemptRecord, PositionProgress } from "./types";

// Test-only builders for the training tests: lines, chapters, catalogs, repertoire trees and
// position items made by hand (moves replayed with chess.js), so these tests do not depend on the
// content compiler. Not imported by the app.

const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const priorityRank = (priority: Priority): number => PRIORITIES.indexOf(priority);

export interface LineSpec {
  id: string;
  side: Color;
  /** Movetext from the start, e.g. "1.c4 e5 2.Nc3". */
  moves: string;
  chapterId?: string;
  chapter?: string;
  family?: string;
  group?: string;
  name?: string;
  priority?: Priority;
  order?: number;
  description?: string;
  plans?: string[];
  recallPly?: number;
  defaultEnabled?: boolean;
}

/** A compiled line, as the content compiler would produce it. */
export function makeLine(spec: LineSpec): Line {
  const sans = parseMovetext(spec.moves);
  const moves = replayMoves(sans);
  const userColor = spec.side;
  return {
    id: spec.id,
    chapterId: spec.chapterId ?? `${spec.side}-chapter`,
    side: spec.side,
    group: spec.group ?? (spec.side === "white" ? "English Opening" : "Against 1.e4"),
    family: spec.family ?? "Test Family",
    chapter: spec.chapter ?? `Chapter ${spec.chapterId ?? `${spec.side}-chapter`}`,
    name: spec.name ?? spec.id,
    eco: null,
    priority: spec.priority ?? "main",
    defaultEnabled: spec.defaultEnabled ?? true,
    description: spec.description ?? `About ${spec.id}.`,
    plans: spec.plans ?? [`Plan of ${spec.id}.`],
    ideas: [],
    traps: [],
    checkpoints: [],
    sans: moves.map((move) => move.san),
    moves,
    epds: [START_EPD, ...moves.map((move) => move.epdAfter)],
    finalFen: moves.length === 0 ? START_FEN : moves[moves.length - 1].fenAfter,
    recallPly: spec.recallPly ?? moves.length,
    userPlies: moves.flatMap((move, index) => (move.color === userColor ? [index + 1] : [])),
    source: { kind: "editorial", references: [] },
    review: { status: "draft", confidence: "medium", checkedWith: [] },
    origin: "builtin",
    order: spec.order ?? 0
  };
}

/** The chapters the lines name (one per chapterId, ordered by the first line's order). */
export function makeChapters(lines: readonly Line[]): Chapter[] {
  const chapters = new Map<string, Chapter>();
  for (const line of [...lines].sort((left, right) => left.order - right.order || byText(left.id, right.id))) {
    const chapter = chapters.get(line.chapterId);
    if (chapter) {
      chapter.lineIds.push(line.id);
      continue;
    }
    chapters.set(line.chapterId, {
      id: line.chapterId,
      side: line.side,
      group: line.group,
      family: line.family,
      chapter: line.chapter,
      order: line.order,
      summary: `About ${line.chapter}.`,
      ideas: ["An idea."],
      source: line.source,
      review: line.review,
      origin: line.origin,
      lineIds: [line.id]
    });
  }
  return [...chapters.values()];
}

/** A catalog of the given lines (chapters derived from them unless given). */
export function makeCatalog(lines: readonly Line[], chapters: readonly Chapter[] = makeChapters(lines)): Catalog {
  return {
    chapters: [...chapters],
    lines: [...lines],
    chapterById: new Map(chapters.map((chapter) => [chapter.id, chapter])),
    lineById: new Map(lines.map((line) => [line.id, line])),
    notes: new Map(),
    issues: []
  };
}

/** The repertoire tree of `side` over the given lines (all treated as enabled). */
export function makeTree(side: Color, lines: readonly Line[]): RepertoireTree {
  const ordered = lines.filter((line) => line.side === side).sort((left, right) => left.order - right.order || byText(left.id, right.id));
  const lineOrder = new Map(ordered.map((line) => [line.id, line.order]));
  const nodes = new Map<string, TreeNode>();

  const visit = (epd: string, fen: string, ply: number, pathSans: string[], lineId: string): TreeNode => {
    let node = nodes.get(epd);
    if (!node) {
      const toMove: Color = epd.split(" ")[1] === "b" ? "black" : "white";
      node = { epd, fen: fenOf(fen), toMove, userToMove: toMove === side, minPly: ply, pathSans, edges: [], lineIds: [] };
      nodes.set(epd, node);
    } else if (ply < node.minPly) {
      node.minPly = ply;
      node.pathSans = pathSans;
    }
    if (!node.lineIds.includes(lineId)) {
      node.lineIds.push(lineId);
    }
    return node;
  };

  for (const line of ordered) {
    line.moves.forEach((move, index) => {
      const node = visit(move.epdBefore, move.fenBefore, index, line.sans.slice(0, index), line.id);
      let edge = node.edges.find((candidate) => candidate.uci === move.uci);
      if (!edge) {
        edge = {
          uci: move.uci,
          san: move.san,
          from: move.from,
          to: move.to,
          mover: move.color === side ? "user" : "opponent",
          lineIds: [],
          priority: line.priority
        };
        node.edges.push(edge);
      }
      if (!edge.lineIds.includes(line.id)) {
        edge.lineIds.push(line.id);
      }
      if (priorityRank(line.priority) < priorityRank(edge.priority)) {
        edge.priority = line.priority;
      }
    });
    visit(line.epds[line.epds.length - 1], line.finalFen, line.moves.length, line.sans, line.id);
  }

  for (const node of nodes.values()) {
    node.edges.sort(
      (left, right) =>
        priorityRank(left.priority) - priorityRank(right.priority) ||
        (lineOrder.get(left.lineIds[0]) ?? 0) - (lineOrder.get(right.lineIds[0]) ?? 0) ||
        byText(left.uci, right.uci)
    );
  }
  return { side, nodes, lineIds: new Set(ordered.map((line) => line.id)) };
}

/** Every user-to-move node with a user edge, as a position item, in teaching order. */
export function makeItems(tree: RepertoireTree, lines: readonly Line[]): PositionItem[] {
  const lineById = new Map(lines.map((line) => [line.id, line]));
  const items: PositionItem[] = [];
  for (const node of tree.nodes.values()) {
    const expected = node.edges.filter((edge) => edge.mover === "user");
    if (!node.userToMove || expected.length === 0) {
      continue;
    }
    const priority = expected.map((edge) => edge.priority).sort((left, right) => priorityRank(left) - priorityRank(right))[0];
    items.push({
      key: posKey(tree.side, node.epd),
      side: tree.side,
      epd: node.epd,
      fen: node.fen,
      expected,
      lineIds: node.lineIds,
      minPly: node.minPly,
      pathSans: node.pathSans,
      priority,
      order: lineById.get(node.lineIds[0])?.order ?? 0
    });
  }
  return items.sort(
    (left, right) =>
      priorityRank(left.priority) - priorityRank(right.priority) ||
      left.order - right.order ||
      left.minPly - right.minPly ||
      byText(left.epd, right.epd)
  );
}

/** A note on `move` (the annotated move), with every optional field empty unless given. */
export function makeNote(move: AppliedMove, extra: Partial<CompiledNote> = {}): CompiledNote {
  return {
    key: move.san,
    chapterId: "test-chapter",
    epdBefore: move.epdBefore,
    uci: move.uci,
    san: move.san,
    mover: move.color,
    idea: null as Idea | null,
    hint: null,
    narrow: null,
    why: `Why ${move.san}.`,
    fits: null,
    avoids: null,
    alternatives: [],
    mistakes: [],
    ...extra
  };
}

/** The applied moves of a movetext from the start. */
export function playMoves(movetext: string): AppliedMove[] {
  return replayMoves(parseMovetext(movetext));
}

/** The last applied move of a movetext and the moves before it. */
export function lastMove(movetext: string): { move: AppliedMove; history: AppliedMove[]; ply: number } {
  const moves = playMoves(movetext);
  return { move: moves[moves.length - 1], history: moves.slice(0, -1), ply: moves.length };
}

/** A position progress record with defaults, for queue and stats tests. */
export function makeProgress(side: Color, epd: string, extra: Partial<PositionProgress> = {}): PositionProgress {
  return {
    key: posKey(side, epd),
    side,
    epd,
    attempts: 0,
    clean: 0,
    incorrect: 0,
    wrongTries: 0,
    hintsUsed: 0,
    reveals: 0,
    firstSeenAt: null,
    lastPracticedAt: null,
    lastResult: null,
    recent: [],
    mastery: 0,
    srs: newSrs(),
    weakMoves: [],
    ...extra
  };
}

/** An attempt record with defaults, for stats tests. */
export function makeAttempt(extra: Partial<AttemptRecord> & Pick<AttemptRecord, "at" | "day">): AttemptRecord {
  return {
    mode: "next-move",
    side: "white",
    lineId: null,
    posKey: null,
    epd: null,
    expected: [],
    tries: [],
    hintsShown: 0,
    revealed: false,
    result: "clean",
    durationMs: null,
    ...extra
  };
}

/** The note index key of a move (re-exported for tests that fill Catalog.notes). */
export function noteKeyOf(move: AppliedMove): string {
  return moveKey(move.epdBefore, move.uci);
}

export type { TreeEdge };

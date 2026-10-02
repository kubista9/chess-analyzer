import { Chess } from "chess.js";
import { z } from "zod";
import { formatLine, moveLabel, parseMovetext, pathKey } from "../chess/format";
import { IllegalMoveError, START_EPD, applyMove, fenOf, replayMoves, toEpd, type AppliedMove, type Color } from "../chess/position";
import type { CustomLineRecord } from "../training/types";
import {
  contentFileSchema,
  type Alternative,
  type Checkpoint,
  type ContentFile,
  type KnownMistake,
  type MoveNote,
  type Priority,
  type ReviewMeta,
  type SourceMeta,
  type Trap
} from "./schema";
import type { Chapter, CompiledNote, CompiledTrap, ContentIssue, Line, Origin } from "./types";

// Content JSON → compiled chapters, lines and notes. Every move is replayed with chess.js; a
// line with an error is left out (so the trainer never teaches a broken line), while problems
// that do not make a line wrong (an extra trap, a bad alternative) only drop that part.

/** The Repertoire page group of every line the user adds in the app. */
export const CUSTOM_GROUP = "My lines";

/** Chapter `order` of the first custom chapter (unitless sort key): custom chapters sort after every built-in one. */
export const CUSTOM_CHAPTER_ORDER = 100_000;

/** The priority of a line the user adds in the app: it is their own repertoire. */
export const CUSTOM_LINE_PRIORITY: Priority = "main";

const CUSTOM_SOURCE: SourceMeta = { kind: "user", references: [] };
const CUSTOM_REVIEW: ReviewMeta = { status: "draft", confidence: "low", checkedWith: [] };

/** A validated content file (null when it does not validate) and the problems found. */
export interface ParsedContentFile {
  file: ContentFile | null;
  issues: ContentIssue[];
}

/** One chapter file after replaying: the lines and notes that compiled, and the issues. */
export interface CompiledChapter {
  chapter: Chapter;
  lines: Line[];
  notes: CompiledNote[];
  issues: ContentIssue[];
}

/** The user's own lines as chapters under "My lines". */
export interface CompiledCustomLines {
  chapters: Chapter[];
  lines: Line[];
  issues: ContentIssue[];
}

/** One zod path as text: lines.0.moves, notes."1.c4 e5".why. */
function formatPath(path: readonly PropertyKey[]): string {
  return path
    .map((key) => {
      const text = String(key);
      return typeof key === "number" || /^[A-Za-z_][\w-]*$/.test(text) ? text : JSON.stringify(text);
    })
    .join(".");
}

function rawField(json: unknown, key: string): unknown {
  return json !== null && typeof json === "object" ? (json as Record<string, unknown>)[key] : undefined;
}

/** Largest edit distance (in characters) at which an unknown field gets a "did you mean" suggestion. */
export const FIELD_SUGGESTION_DISTANCE = 2;

/** Levenshtein distance between two short strings. */
function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost));
    }
    previous = current;
  }
  return previous[right.length];
}

/** The known field closest to `key` within FIELD_SUGGESTION_DISTANCE (ties: alphabetical), or null. */
function closestField(key: string, known: readonly string[]): string | null {
  let best: { field: string; distance: number } | null = null;
  for (const field of [...known].sort()) {
    const distance = editDistance(key.toLowerCase(), field.toLowerCase());
    if (distance <= FIELD_SUGGESTION_DISTANCE && (best === null || distance < best.distance)) {
      best = { field, distance };
    }
  }
  return best?.field ?? null;
}

/** A field the schema does not know: zod would drop it without a word. */
interface UnknownField {
  path: PropertyKey[];
  suggestion: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Every field of `json` that `schema` does not define, in document order. Values of the wrong
 * type are skipped (zod reports those).
 */
function unknownFields(schema: z.core.$ZodType, json: unknown, path: PropertyKey[] = [], found: UnknownField[] = []): UnknownField[] {
  let inner = schema;
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault || inner instanceof z.ZodNullable) {
    inner = inner.unwrap();
  }
  if (inner instanceof z.ZodObject && isRecord(json)) {
    const shape: Record<string, z.core.$ZodType> = inner.shape;
    for (const [key, value] of Object.entries(json)) {
      if (Object.hasOwn(shape, key)) {
        unknownFields(shape[key], value, [...path, key], found);
      } else {
        found.push({ path: [...path, key], suggestion: closestField(key, Object.keys(shape)) });
      }
    }
  } else if (inner instanceof z.ZodRecord && isRecord(json)) {
    for (const [key, value] of Object.entries(json)) {
      unknownFields(inner.valueType, value, [...path, key], found);
    }
  } else if (inner instanceof z.ZodArray && Array.isArray(json)) {
    json.forEach((value, index) => unknownFields(inner.element, value, [...path, index], found));
  }
  return found;
}

/**
 * Validates one content file with the zod schema. Issue messages read "path: message"; an issue's
 * fileId is the file's own `id` when it has one, else `fileName`. A field the schema does not
 * know is an error too, since zod would drop it silently and a misspelt optional field
 * ("defaultEnable", "recal", "hnt") changes what is taught; the file is still returned when it
 * otherwise validates, with such fields ignored.
 */
export function parseContentFile(json: unknown, fileName?: string): ParsedContentFile {
  const result = contentFileSchema.safeParse(json);
  const rawId = rawField(json, "id");
  const fileId = typeof rawId === "string" && rawId.trim() !== "" ? rawId : fileName;
  const rawLines = rawField(json, "lines");
  const issueAt = (issuePath: readonly PropertyKey[], message: string): ContentIssue => {
    const path = formatPath(issuePath);
    const lineIndex = issuePath[0] === "lines" && typeof issuePath[1] === "number" ? issuePath[1] : null;
    const lineId = lineIndex !== null && Array.isArray(rawLines) ? rawField(rawLines[lineIndex], "id") : undefined;
    return {
      level: "error",
      ...(fileId !== undefined ? { fileId } : {}),
      ...(typeof lineId === "string" ? { lineId } : {}),
      ...(path ? { path } : {}),
      message: `${path || "(file)"}: ${message}`
    };
  };
  const issues = [
    ...(result.success ? [] : result.error.issues.map((issue) => issueAt(issue.path, issue.message))),
    ...unknownFields(contentFileSchema, json).map(({ path, suggestion }) =>
      issueAt(path, `unknown field${suggestion ? ` (did you mean "${suggestion}"?)` : ""}; it is ignored`)
    )
  ];
  return { file: result.success ? result.data : null, issues };
}

/** The EPD of a FEN as chess.js writes it (an en-passant square only when the capture is legal), or null. */
function canonicalEpd(fen: string): string | null {
  try {
    return toEpd(new Chess(fenOf(fen)).fen());
  } catch {
    return null;
  }
}

/** "4.Bg3 is not legal after 1.c4 e5 2.Nc3 Bc5 3.g3 Qf6" for a movetext that fails at `index`. */
function illegalMessage(tokens: readonly string[], index: number): string {
  const where = index === 0 ? "in the starting position" : `after ${formatLine(tokens.slice(0, index))}`;
  return `${moveLabel(index + 1, tokens[index])} is not legal ${where}`;
}

type Replay = { moves: AppliedMove[]; error: null } | { moves: null; error: string };

/** Parses and replays a movetext from the start position. */
function replayMovetext(movetext: string): Replay {
  const tokens = parseMovetext(movetext);
  if (tokens.length === 0) {
    return { moves: null, error: "no moves found" };
  }
  try {
    return { moves: replayMoves(tokens), error: null };
  } catch (error) {
    if (error instanceof IllegalMoveError) {
      return { moves: null, error: illegalMessage(tokens, error.index) };
    }
    throw error;
  }
}

/** What a line needs to compile, from a content file or from a custom line record. */
interface LineInput {
  id: string;
  name: string;
  family: string;
  eco: string | null;
  priority: Priority;
  defaultEnabled: boolean;
  moves: string;
  description: string;
  plans: string[];
  ideas: string[];
  traps: Trap[];
  checkpoints: Checkpoint[];
  recallPly: number | null;
  source: SourceMeta;
  review: ReviewMeta;
}

function compileLine(input: LineInput, chapter: Chapter, order: number, issues: ContentIssue[]): Line | null {
  const report = (level: ContentIssue["level"], path: string, message: string) => {
    issues.push({ level, fileId: chapter.id, lineId: input.id, path, message: `${path}: ${message}` });
  };

  const replay = replayMovetext(input.moves);
  if (replay.error !== null) {
    report("error", "moves", replay.error);
    return null;
  }
  const moves = replay.moves;
  const plies = moves.length;
  const sans = moves.map((move) => move.san);
  const epds = [START_EPD, ...moves.map((move) => move.epdAfter)];
  let valid = true;

  const recallPly = input.recallPly ?? plies;
  if (recallPly > plies) {
    report("error", "recall.ply", `ply ${recallPly} is beyond the end of the line (${plies} plies)`);
    valid = false;
  }

  input.checkpoints.forEach((checkpoint, index) => {
    const path = `checkpoints.${index}`;
    if (checkpoint.ply > plies) {
      report("error", path, `ply ${checkpoint.ply} is beyond the end of the line (${plies} plies)`);
      valid = false;
      return;
    }
    const expected = canonicalEpd(checkpoint.fen);
    if (expected === null) {
      report("error", path, `"${checkpoint.fen}" is not a valid FEN`);
      valid = false;
    } else if (expected !== epds[checkpoint.ply]) {
      const after = moveLabel(checkpoint.ply, sans[checkpoint.ply - 1]);
      report("error", path, `the position after ${after} is "${moves[checkpoint.ply - 1].fenAfter}", not "${checkpoint.fen}"`);
      valid = false;
    }
  });

  // A broken trap only loses the trap: the line itself is still right.
  const traps: CompiledTrap[] = [];
  input.traps.forEach((trap, index) => {
    const trapReplay = replayMovetext(trap.moves);
    if (trapReplay.error !== null) {
      report("error", `traps.${index}`, `trap "${trap.name}": ${trapReplay.error}; the trap is left out`);
      return;
    }
    traps.push({ ...trap, sans: trapReplay.moves.map((move) => move.san), played: trapReplay.moves });
  });

  if (!valid) {
    return null;
  }

  const last = moves[plies - 1];
  if (last.color !== chapter.side) {
    report("warning", "moves", `the line ends on the opponent's move ${moveLabel(plies, last.san)}; end it on your own move`);
  }

  return {
    id: input.id,
    chapterId: chapter.id,
    side: chapter.side,
    group: chapter.group,
    family: input.family,
    chapter: chapter.chapter,
    name: input.name,
    eco: input.eco,
    priority: input.priority,
    defaultEnabled: input.defaultEnabled,
    description: input.description,
    plans: [...input.plans],
    ideas: [...input.ideas],
    traps,
    checkpoints: input.checkpoints.map((checkpoint) => ({ ...checkpoint })),
    sans,
    moves,
    epds,
    finalFen: last.fenAfter,
    recallPly,
    userPlies: moves.flatMap((move, index) => (move.color === chapter.side ? [index + 1] : [])),
    source: input.source,
    review: input.review,
    origin: chapter.origin,
    order
  };
}

/**
 * Checks a note's alternatives and mistakes against the position before the annotated move:
 * each must be a legal move other than the annotated one, listed once. Stores canonical SAN.
 */
function checkedEntries<T extends Alternative | KnownMistake>(
  entries: readonly T[],
  kind: "alternative" | "mistake",
  annotated: AppliedMove,
  used: Set<string>,
  warn: (message: string) => void
): T[] {
  const kept: T[] = [];
  for (const entry of entries) {
    const move = applyMove(annotated.fenBefore, entry.san);
    if (!move) {
      warn(`${kind} "${entry.san}" is not legal in that position; it is left out`);
    } else if (move.uci === annotated.uci) {
      warn(`${kind} "${entry.san}" is the annotated move itself; it is left out`);
    } else if (used.has(move.uci)) {
      warn(`${kind} "${entry.san}" is listed twice; the second entry is left out`);
    } else {
      used.add(move.uci);
      kept.push({ ...entry, san: move.san });
    }
  }
  return kept;
}

function compileNote(key: string, note: MoveNote, chapterId: string, issues: ContentIssue[]): CompiledNote | null {
  const path = `notes.${JSON.stringify(key)}`;
  const replay = replayMovetext(key);
  if (replay.error !== null) {
    issues.push({ level: "error", fileId: chapterId, path, message: `${path}: ${replay.error}; the note is left out` });
    return null;
  }
  const annotated = replay.moves[replay.moves.length - 1];
  const warn = (message: string) => issues.push({ level: "warning", fileId: chapterId, path, message: `${path}: ${message}` });
  const used = new Set<string>();
  const alternatives = checkedEntries(note.alternatives, "alternative", annotated, used, warn);
  const mistakes = checkedEntries(note.mistakes, "mistake", annotated, used, warn);
  return {
    key: pathKey(replay.moves.map((move) => move.san)),
    chapterId,
    epdBefore: annotated.epdBefore,
    uci: annotated.uci,
    san: annotated.san,
    mover: annotated.color,
    idea: note.idea ?? null,
    hint: note.hint ?? null,
    narrow: note.narrow ?? null,
    why: note.why,
    fits: note.fits ?? null,
    avoids: note.avoids ?? null,
    alternatives,
    mistakes
  };
}

/**
 * Compiles one validated chapter file: replays every line, checkpoint, trap and note. `orderBase`
 * is the teaching order of the chapter's first line (line i gets orderBase + i).
 */
export function compileChapter(file: ContentFile, origin: Origin, orderBase: number): CompiledChapter {
  const chapter: Chapter = {
    id: file.id,
    side: file.side,
    group: file.group,
    family: file.family,
    chapter: file.chapter,
    order: file.order,
    summary: file.summary,
    ideas: [...file.ideas],
    source: file.source,
    review: file.review,
    origin,
    lineIds: []
  };
  const issues: ContentIssue[] = [];
  const lines: Line[] = [];
  file.lines.forEach((def, index) => {
    const line = compileLine(
      {
        id: def.id,
        name: def.name,
        family: file.family,
        eco: def.eco ?? null,
        priority: def.priority,
        defaultEnabled: def.defaultEnabled,
        moves: def.moves,
        description: def.description,
        plans: def.plans,
        ideas: def.ideas,
        traps: def.traps,
        checkpoints: def.checkpoints,
        recallPly: def.recall?.ply ?? null,
        source: def.source ?? file.source,
        review: def.review ?? file.review
      },
      chapter,
      orderBase + index,
      issues
    );
    if (line) {
      lines.push(line);
      chapter.lineIds.push(line.id);
    }
  });
  const notes: CompiledNote[] = [];
  for (const [key, note] of Object.entries(file.notes)) {
    const compiled = compileNote(key, note, file.id, issues);
    if (compiled) {
      notes.push(compiled);
    }
  }
  return { chapter, lines, notes, issues };
}

/** A chapter title as an id part: "1...e5: the Reversed Sicilian" → "1-e5-the-reversed-sicilian". */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "lines";
}

const SIDE_RANK: Record<Color, number> = { white: 0, black: 1 };

/**
 * Compiles the lines the user added in the app. One chapter per side and chapter title (titles
 * that slugify alike share a chapter), listed under "My lines"; lines in the order they were
 * added. `orderBase` continues the built-in teaching order.
 */
export function compileCustomLines(records: readonly CustomLineRecord[], orderBase: number): CompiledCustomLines {
  const sorted = [...records].sort(
    (left, right) =>
      SIDE_RANK[left.side] - SIDE_RANK[right.side] ||
      left.createdAt - right.createdAt ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
  const groups = new Map<string, { side: Color; title: string; records: CustomLineRecord[] }>();
  for (const record of sorted) {
    const title = record.chapter.trim() || CUSTOM_GROUP;
    const id = `custom-${record.side}-${slugify(title)}`;
    const group = groups.get(id) ?? { side: record.side, title, records: [] };
    group.records.push(record);
    groups.set(id, group);
  }
  const ids = [...groups.keys()].sort((left, right) => {
    const a = groups.get(left)!;
    const b = groups.get(right)!;
    return SIDE_RANK[a.side] - SIDE_RANK[b.side] || (left < right ? -1 : left > right ? 1 : 0);
  });

  const chapters: Chapter[] = [];
  const lines: Line[] = [];
  const issues: ContentIssue[] = [];
  let order = orderBase;
  ids.forEach((id, index) => {
    const group = groups.get(id)!;
    const chapter: Chapter = {
      id,
      side: group.side,
      group: CUSTOM_GROUP,
      family: group.records[0].family.trim() || CUSTOM_GROUP,
      chapter: group.title,
      order: CUSTOM_CHAPTER_ORDER + index,
      summary: "Lines you added yourself.",
      ideas: [],
      source: CUSTOM_SOURCE,
      review: CUSTOM_REVIEW,
      origin: "custom",
      lineIds: []
    };
    for (const record of group.records) {
      const line = compileLine(
        {
          id: record.id,
          name: record.name,
          family: record.family.trim() || chapter.family,
          eco: record.eco,
          priority: CUSTOM_LINE_PRIORITY,
          defaultEnabled: true,
          moves: record.moves,
          description: record.description,
          plans: record.plans,
          ideas: [],
          traps: [],
          checkpoints: [],
          recallPly: null,
          source: CUSTOM_SOURCE,
          review: CUSTOM_REVIEW
        },
        chapter,
        order,
        issues
      );
      order += 1;
      if (line) {
        lines.push(line);
        chapter.lineIds.push(line.id);
      }
    }
    if (chapter.lineIds.length > 0) {
      chapters.push(chapter);
    }
  });
  return { chapters, lines, issues };
}

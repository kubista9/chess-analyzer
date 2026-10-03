import { z } from "zod";

// The editable repertoire content format. One JSON file per chapter lives under content/white/
// or content/black/; the app validates every file with these schemas at load time and
// `npm run content:check` replays every move with chess.js. See content/README.md.
//
// Moves are written as plain movetext ("1.c4 e5 2.Nc3 Nf6"). Explanations are keyed by the move
// path that ends with the annotated move ("1.c4 e5 2.Nc3" describes 2.Nc3), so lines that share
// moves share their notes, and a transposition finds the note by position.

export const SIDES = ["white", "black"] as const;

/**
 * The idea behind a move, used for the first hint ("think about development") without naming the
 * move. Keep the list short: each value has a default hint sentence in core/training/hints.ts.
 */
export const IDEAS = [
  "centre", // fight for or influence the centre
  "development", // bring a knight or bishop out (a fianchetto included)
  "king-safety", // castle or keep the king's shelter intact
  "prevention", // stop the opponent's plan or threat
  "space", // gain space or restrict an opponent's piece
  "structure", // choose or fix a pawn structure (which way to recapture, doubled pawns)
  "recapture", // win back material
  "tempo", // gain time by attacking a piece
  "flank", // wing play: a queenside or kingside pawn advance
  "activity" // improve a piece already developed, connect the rooks
] as const;

export const PRIORITIES = ["main", "secondary", "sideline"] as const;

export const REVIEW_STATUSES = ["draft", "reviewed", "verified"] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;

export type Side = (typeof SIDES)[number];
export type Idea = (typeof IDEAS)[number];
export type Priority = (typeof PRIORITIES)[number];

const text = z.string().trim().min(1);
const movetext = z.string().trim().min(2);
const lineId = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "ids are lower-case words joined by hyphens, e.g. eng-e5-four-knights");

export const sourceSchema = z.object({
  /** editorial: written for this app; user: added in the app; import: imported from PGN. */
  kind: z.enum(["editorial", "user", "import"]),
  /** What the content is based on, e.g. "Opening principles: Chess Opening Fundamentals (I. Smirnov), ideas only". */
  references: z.array(text).default([]),
  author: text.optional(),
  note: text.optional()
});

export const reviewSchema = z.object({
  /** draft: written, not reviewed; reviewed: an editor checked it; verified: also engine-checked. */
  status: z.enum(REVIEW_STATUSES),
  confidence: z.enum(CONFIDENCES),
  /** How it was checked, e.g. ["chess.js legality", "Stockfish 18 depth 18"]. */
  checkedWith: z.array(text).default([]),
  /** ISO date of the last review, e.g. "2026-10-02". */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: text.optional()
});

export const alternativeSchema = z.object({
  /** An acceptable move instead of the annotated one, in the same position. */
  san: text,
  /** Why it is acceptable and where it leads; plain words, no engine numbers. */
  note: text,
  /** It usually reaches the same position by another move order. */
  transposes: z.boolean().optional()
});

export const mistakeSchema = z.object({
  /** A move that is a known error in the position before the annotated move. */
  san: text,
  /** What goes wrong, e.g. "allows ...Qxf2 mate". */
  note: text,
  severity: z.enum(["inaccuracy", "mistake"]).default("mistake")
});

export const moveNoteSchema = z.object({
  idea: z.enum(IDEAS).optional(),
  /** First hint: names the idea only. Must not name the move, the piece's target square or the move's SAN. */
  hint: text.optional(),
  /** Second hint: narrows it to a piece or an area of the board, still without the exact move. */
  narrow: text.optional(),
  /** What the move achieves. Shown after the move is found or revealed. For opponent moves: what they intend. */
  why: text,
  /** Why it fits this opening's plans. */
  fits: text.optional(),
  /** The common mistake it avoids. */
  avoids: text.optional(),
  alternatives: z.array(alternativeSchema).default([]),
  mistakes: z.array(mistakeSchema).default([])
});

export const trapSchema = z.object({
  name: text,
  /** The full move path from the start, e.g. "1.c4 e5 2.Nc3 Bc5 3.g3 Qf6 4.Bg2 Qxf2#". */
  moves: movetext,
  /** "for": a trap the opponent can fall into; "against": one you must not fall into. */
  side: z.enum(["for", "against"]),
  description: text
});

export const checkpointSchema = z.object({
  /** The FEN after this many plies of the line (ply 1 = White's first move). */
  ply: z.number().int().positive(),
  fen: text,
  label: text.optional()
});

export const lineSchema = z.object({
  /** Stable: progress is stored under it. Never reuse an id for a different line. */
  id: lineId,
  name: text,
  eco: z
    .string()
    .regex(/^[A-E]\d\d$/)
    .optional(),
  /** main lines are taught first, sidelines last. */
  priority: z.enum(PRIORITIES),
  /** Whether the line is part of the repertoire until the user changes it. */
  defaultEnabled: z.boolean().default(true),
  /** The whole line from the start position. */
  moves: movetext,
  description: text,
  plans: z.array(text).min(1),
  ideas: z.array(text).default([]),
  traps: z.array(trapSchema).default([]),
  checkpoints: z.array(checkpointSchema).default([]),
  /** The position Position Recall shows: after `ply` plies (default: the end of the line). */
  recall: z
    .object({
      ply: z.number().int().positive().optional()
    })
    .optional(),
  source: sourceSchema.optional(),
  review: reviewSchema.optional()
});

export const contentFileSchema = z.object({
  schemaVersion: z.literal(1),
  /** Unique chapter id, e.g. "white-english-e5". */
  id: lineId,
  /** The colour the user plays in every line of this chapter. */
  side: z.enum(SIDES),
  /** The Repertoire page's top grouping, e.g. "English Opening" or "Against 1.e4". */
  group: text,
  /** The opening family, e.g. "English Opening", "Scandinavian Defence". */
  family: text,
  /** The chapter title, e.g. "1...e5: the Reversed Sicilian". */
  chapter: text,
  /** Sort order within the side (lower first). */
  order: z.number(),
  summary: text,
  ideas: z.array(text).min(1),
  source: sourceSchema,
  review: reviewSchema,
  /** Move notes keyed by the move path that ends with the annotated move, e.g. "1.c4 e5 2.Nc3". */
  notes: z.record(z.string(), moveNoteSchema).default({}),
  lines: z.array(lineSchema).min(1)
});

export type SourceMeta = z.infer<typeof sourceSchema>;
export type ReviewMeta = z.infer<typeof reviewSchema>;
export type Alternative = z.infer<typeof alternativeSchema>;
export type KnownMistake = z.infer<typeof mistakeSchema>;
export type MoveNote = z.infer<typeof moveNoteSchema>;
export type Trap = z.infer<typeof trapSchema>;
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type LineDef = z.infer<typeof lineSchema>;
export type ContentFile = z.infer<typeof contentFileSchema>;
/** The JSON as written (defaults not yet applied). */
export type ContentFileInput = z.input<typeof contentFileSchema>;

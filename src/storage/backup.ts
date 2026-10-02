import { z } from "zod";
import type { Color } from "../core/chess/position";
import { posKey } from "../core/content/types";
import type {
  AttemptRecord,
  CustomLineRecord,
  LineProgress,
  LineState,
  LineStatus,
  Mode,
  PositionProgress,
  Result,
  Settings,
  SrsState,
  Verdict
} from "../core/training/types";
import { dayKey } from "../core/util/time";
import { mergeSettings } from "./settings";

// The backup file: everything the store holds, as one JSON document the user can save and import
// again (on this device or another). A file is validated completely before anything is written,
// so a damaged or foreign file never leaves half an import behind.
//
// Export and import agree: an export goes through the same schema as an import (prepareBackup),
// so a file this app writes always imports again. The schema is lenient where the store's types
// are: settings go through mergeSettings, and a number the types allow but the format does not (a
// negative duration after a clock change, a fractional or negative count, a mastery of
// 1.0000000002, a NaN) is repaired instead of rejected, so one odd value never blocks a restore.
// Anything else that does not fit (a wrong type, an unknown choice, an empty id, a malformed day)
// is an error: a damaged file is refused, and a damaged store cannot be exported.

/** The `app` value of every backup file. */
export const BACKUP_APP = "opening-trainer";

/** The backup format this build writes and reads. */
export const BACKUP_FORMAT = 1;

/** Problems quoted in a BackupError message before "and N more", problems. */
export const BACKUP_ISSUES_SHOWN = 3;

export interface BackupFile {
  app: typeof BACKUP_APP;
  format: typeof BACKUP_FORMAT;
  /** ms. */
  exportedAt: number;
  settings: Settings;
  lineStates: LineState[];
  positionProgress: PositionProgress[];
  lineProgress: LineProgress[];
  /** In id order, ids included (a replace import keeps them). */
  attempts: AttemptRecord[];
  customLines: CustomLineRecord[];
}

/** Records an import wrote, by kind (in a merge, only the new or newer ones). */
export interface ImportSummary {
  positions: number;
  lines: number;
  attempts: number;
  customLines: number;
  lineStates: number;
}

/** A backup that cannot be imported (or made). The message is a complete sentence for the user. */
export class BackupError extends Error {
  /** Every problem found, as "path: message" (empty when the file is not a backup at all). */
  readonly issues: string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "BackupError";
    this.issues = [...issues];
  }
}

// Records, not arrays, so the compiler insists on every member of each union.
function choices<T extends string>(set: Record<T, true>): [T, ...T[]] {
  return Object.keys(set) as [T, ...T[]];
}

const colorSchema = z.enum(choices<Color>({ white: true, black: true }));
const resultSchema = z.enum(choices<Result>({ clean: true, hinted: true, retried: true, revealed: true }));
const verdictSchema = z.enum(choices<Verdict>({ book: true, alternative: true, inaccuracy: true, mistake: true, unverified: true }));
const modeSchema = z.enum(choices<Mode>({ "next-move": true, "play-line": true, recall: true, sparring: true }));
const lineStatusSchema = z.enum(choices<LineStatus>({ learning: true, reviewing: true, mastered: true }));

/** ms since the epoch. */
const timeSchema = z.number();
/** ms since the epoch, or null; a non-finite time (which JSON would write as null anyway) becomes null. */
const nullableTimeSchema = z.preprocess(
  repairNumber((value) => (Number.isFinite(value) ? value : null)),
  timeSchema.nullable()
);
/** A whole number of things: rounded and at least 0; a non-finite count is 0. */
const countSchema = z.preprocess(
  repairNumber((value) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0)),
  z.number().int().nonnegative()
);
/** A fraction, 0..1 (clamped); a non-finite one is 0. */
const fractionSchema = z.preprocess(
  repairNumber((value) => (Number.isFinite(value) ? clamp(value, 0, 1) : 0)),
  z.number().min(0).max(1)
);
/** Hints shown in one exercise, 0..2 (rounded and clamped); a non-finite count is 0. */
const hintsShownSchema = z.preprocess(
  repairNumber((value) => (Number.isFinite(value) ? clamp(Math.round(value), 0, 2) : 0)),
  z.union([z.literal(0), z.literal(1), z.literal(2)])
);
/** ms, or null when unknown; a negative or non-finite duration (the clock changed) is unknown. */
const durationSchema = z.preprocess(
  repairNumber((value) => (Number.isFinite(value) && value >= 0 ? value : null)),
  z.number().nonnegative().nullable()
);
const idSchema = z.string().min(1);
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export const srsStateSchema = z.object({
  box: countSchema,
  dueAt: nullableTimeSchema,
  introducedAt: nullableTimeSchema,
  lapses: countSchema,
  streak: countSchema,
  reviews: countSchema,
  lastReviewAt: nullableTimeSchema
}) satisfies z.ZodType<SrsState>;

export const positionProgressSchema = z
  .object({
    key: idSchema,
    side: colorSchema,
    epd: idSchema,
    attempts: countSchema,
    clean: countSchema,
    incorrect: countSchema,
    wrongTries: countSchema,
    hintsUsed: countSchema,
    reveals: countSchema,
    firstSeenAt: nullableTimeSchema,
    lastPracticedAt: nullableTimeSchema,
    lastResult: resultSchema.nullable(),
    recent: z.array(resultSchema),
    mastery: fractionSchema,
    srs: srsStateSchema,
    weakMoves: z.array(z.object({ san: idSchema, count: countSchema, lastAt: timeSchema }))
  })
  .refine((progress) => progress.key === posKey(progress.side, progress.epd), {
    message: "the key does not match the side and position",
    path: ["key"]
  }) satisfies z.ZodType<PositionProgress>;

export const lineProgressSchema = z.object({
  lineId: idSchema,
  runs: countSchema,
  cleanRuns: countSchema,
  movesPlayed: countSchema,
  movesClean: countSchema,
  wrongTries: countSchema,
  hintsUsed: countSchema,
  reveals: countSchema,
  recallAttempts: countSchema,
  recallCorrect: countSchema,
  lastPracticedAt: nullableTimeSchema,
  lastResult: resultSchema.nullable(),
  srs: srsStateSchema
}) satisfies z.ZodType<LineProgress>;

export const lineStateSchema = z.object({
  lineId: idSchema,
  enabled: z.boolean(),
  status: lineStatusSchema,
  statusSetAt: nullableTimeSchema,
  updatedAt: timeSchema
}) satisfies z.ZodType<LineState>;

export const attemptRecordSchema = z.object({
  id: z.number().int().positive().optional(),
  at: timeSchema,
  day: z.string().regex(DAY_KEY, "expected a day as YYYY-MM-DD"),
  mode: modeSchema,
  side: colorSchema,
  lineId: idSchema.nullable(),
  posKey: idSchema.nullable(),
  epd: idSchema.nullable(),
  expected: z.array(z.string()),
  tries: z.array(z.object({ san: z.string(), verdict: verdictSchema })),
  hintsShown: hintsShownSchema,
  revealed: z.boolean(),
  result: resultSchema,
  durationMs: durationSchema
}) satisfies z.ZodType<AttemptRecord>;

export const customLineRecordSchema = z.object({
  id: idSchema,
  side: colorSchema,
  chapter: z.string(),
  family: z.string(),
  name: z.string(),
  eco: z.string().nullable(),
  moves: z.string(),
  description: z.string(),
  plans: z.array(z.string()),
  createdAt: timeSchema,
  updatedAt: timeSchema
}) satisfies z.ZodType<CustomLineRecord>;

/** The whole file. Unknown keys are dropped; duplicate keys within a store are an error. */
export const backupSchema = z
  .object({
    app: z.literal(BACKUP_APP),
    format: z.literal(BACKUP_FORMAT),
    exportedAt: timeSchema,
    settings: z.record(z.string(), z.unknown()).transform((settings) => mergeSettings(settings)),
    lineStates: z.array(lineStateSchema),
    positionProgress: z.array(positionProgressSchema),
    lineProgress: z.array(lineProgressSchema),
    attempts: z.array(attemptRecordSchema),
    customLines: z.array(customLineRecordSchema)
  })
  .superRefine((backup, context) => {
    const checks: [keyof BackupFile, readonly (string | number | undefined)[]][] = [
      ["lineStates", backup.lineStates.map((state) => state.lineId)],
      ["positionProgress", backup.positionProgress.map((progress) => progress.key)],
      ["lineProgress", backup.lineProgress.map((progress) => progress.lineId)],
      ["attempts", backup.attempts.map((attempt) => attempt.id)],
      ["customLines", backup.customLines.map((line) => line.id)]
    ];
    for (const [store, keys] of checks) {
      const seen = new Set<string | number>();
      keys.forEach((key, index) => {
        if (key === undefined) {
          return;
        }
        if (seen.has(key)) {
          context.addIssue({ code: "custom", path: [store, index], message: `the key ${JSON.stringify(key)} appears more than once` });
        }
        seen.add(key);
      });
    }
  }) satisfies z.ZodType<BackupFile>;

/** Validates a backup (the parsed object, or the file's text) and returns it with settings normalised; throws BackupError. */
export function parseBackup(input: unknown): BackupFile {
  let data = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input) as unknown;
    } catch {
      throw new BackupError("This file is not a backup of the opening trainer: it is not valid JSON.");
    }
  }
  if (!isRecord(data) || data.app !== BACKUP_APP) {
    throw new BackupError("This file is not a backup of the opening trainer.");
  }
  if (data.format !== BACKUP_FORMAT) {
    throw new BackupError(
      typeof data.format === "number" && data.format > BACKUP_FORMAT
        ? `This backup was made by a newer version of the app (format ${data.format}). Update the app, then import it again.`
        : "This backup has a format this app does not know, so it cannot be imported."
    );
  }
  const parsed = backupSchema.safeParse(data);
  if (!parsed.success) {
    throw damaged("This backup is damaged or incomplete, so it cannot be imported", parsed.error);
  }
  return parsed.data;
}

/**
 * The file to write for the store's contents, repaired exactly as an import repairs them, so it
 * imports again unchanged. Throws BackupError when a record is damaged beyond repair, so a backup
 * that could not be restored is never handed out.
 */
export function prepareBackup(contents: BackupFile): BackupFile {
  const parsed = backupSchema.safeParse(contents);
  if (!parsed.success) {
    throw damaged("Some saved data is damaged, so a backup cannot be made", parsed.error);
  }
  return parsed.data;
}

/** The suggested file name for a backup made at `now`, e.g. "opening-trainer-backup-2026-10-02.json" (local day). */
export function backupFileName(now: number): string {
  return `opening-trainer-backup-${dayKey(now)}.json`;
}

/** A BackupError that starts with `lead` and quotes the first problems. */
function damaged(lead: string, error: z.ZodError): BackupError {
  const issues = error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message.replace(/^Invalid input: /, "")}`);
  const shown = issues.slice(0, BACKUP_ISSUES_SHOWN).join("; ");
  const more = issues.length > BACKUP_ISSUES_SHOWN ? ` (and ${issues.length - BACKUP_ISSUES_SHOWN} more)` : "";
  return new BackupError(`${lead}: ${shown}${more}.`, issues);
}

/** A preprocess step that repairs numbers and passes anything else on to be checked. */
function repairNumber(repair: (value: number) => number | null): (value: unknown) => unknown {
  return (value) => (typeof value === "number" ? repair(value) : value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "the file";
  }
  return path.map((part, index) => (typeof part === "number" ? `[${part}]` : `${index === 0 ? "" : "."}${String(part)}`)).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

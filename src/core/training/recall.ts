import { fenOf, toEpd, type Color } from "../chess/position";
import type { Line } from "../content/types";
import { shuffled, type Rng } from "../util/random";

// Position Recall: the board shows a line's recall position and the user names the line
// ("opening") or its plan ("plan") from a few options. A distractor must never be a right answer
// too, so a line whose moves pass through the shown position is never offered as a distractor.

/** What a recall question asks for: the line's name or its plan. */
export type RecallKind = "opening" | "plan";

/** One multiple-choice Position Recall question. */
export interface RecallQuestion {
  id: string;
  kind: RecallKind;
  lineId: string;
  /** The position after line.recallPly plies. */
  fen: string;
  orientation: Color;
  /** The SAN moves that lead to `fen`. */
  movesShown: string[];
  prompt: string;
  options: { id: string; label: string }[];
  correctId: string;
  explanation: string;
}

/** Distractors offered at most (options). */
export const RECALL_DISTRACTORS = 3;

/** An opening question needs at least this many options, the correct one included (options). */
export const MIN_OPENING_OPTIONS = 2;

/** A plan question needs at least this many options, the correct one included (options). */
export const MIN_PLAN_OPTIONS = 3;

/** The question asked for each kind. */
export const RECALL_PROMPTS: Record<RecallKind, string> = {
  opening: "Which of your lines reaches this position?",
  plan: "What is the usual plan from this position?"
};

const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const normalised = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

function recallPlyOf(line: Line): number {
  const ply = Number.isFinite(line.recallPly) ? Math.trunc(line.recallPly) : line.moves.length;
  return Math.min(Math.max(ply, 0), line.moves.length);
}

/** The full FEN of the line's recall position. */
function recallFen(line: Line): string {
  const ply = recallPlyOf(line);
  return ply === 0 ? fenOf(line.epds[0]) : line.moves[ply - 1].fenAfter;
}

/** Shuffles each tier (in a fixed starting order, so a seed gives the same result) and keeps tier order. */
function tiered(tiers: readonly Line[][], rng: Rng): Line[] {
  return tiers.flatMap((tier) => shuffled([...tier].sort((left, right) => left.order - right.order || byText(left.id, right.id)), rng));
}

/** Up to RECALL_DISTRACTORS candidates whose label differs from the answer's and from each other. */
function pickDistinct(candidates: readonly Line[], label: (line: Line) => string, answer: string): Line[] {
  const used = new Set<string>([normalised(answer)]);
  const picked: Line[] = [];
  for (const candidate of candidates) {
    const key = normalised(label(candidate));
    if (key === "" || used.has(key)) {
      continue;
    }
    used.add(key);
    picked.push(candidate);
    if (picked.length === RECALL_DISTRACTORS) {
      break;
    }
  }
  return picked;
}

/**
 * A recall question for `line`, or null when there are too few valid distractors.
 * - opening: the line's name and up to 3 other lines of the same side (same chapter first, then
 *   the same family, then any);
 * - plan: the line's first plan and the first plans of lines from other chapters (the same side
 *   first), at least MIN_PLAN_OPTIONS options.
 * Options are shuffled with `rng`; the explanation is the description and the plan.
 */
export function buildRecallQuestion(input: { line: Line; pool: readonly Line[]; kind: RecallKind; rng: Rng }): RecallQuestion | null {
  const { line, pool, kind, rng } = input;
  const ply = recallPlyOf(line);
  const fen = recallFen(line);
  const epd = toEpd(fen);
  const others = pool.filter((other) => other.id !== line.id && !other.epds.includes(epd));
  const plan = line.plans[0] ?? null;

  let answer: string;
  let distractors: { id: string; label: string }[];
  if (kind === "opening") {
    answer = line.name;
    const sameSide = others.filter((other) => other.side === line.side);
    const tiers = [
      sameSide.filter((other) => other.chapterId === line.chapterId),
      sameSide.filter((other) => other.chapterId !== line.chapterId && other.family === line.family),
      sameSide.filter((other) => other.chapterId !== line.chapterId && other.family !== line.family)
    ];
    distractors = pickDistinct(tiered(tiers, rng), (other) => other.name, answer).map((other) => ({ id: other.id, label: other.name }));
    if (distractors.length + 1 < MIN_OPENING_OPTIONS) {
      return null;
    }
  } else {
    if (plan === null) {
      return null;
    }
    answer = plan;
    const withPlans = others.filter((other) => other.chapterId !== line.chapterId && other.plans.length > 0);
    const tiers = [withPlans.filter((other) => other.side === line.side), withPlans.filter((other) => other.side !== line.side)];
    distractors = pickDistinct(tiered(tiers, rng), (other) => other.plans[0], answer).map((other) => ({ id: other.id, label: other.plans[0] }));
    if (distractors.length + 1 < MIN_PLAN_OPTIONS) {
      return null;
    }
  }

  return {
    id: `${kind}:${line.id}`,
    kind,
    lineId: line.id,
    fen,
    orientation: line.side,
    movesShown: line.sans.slice(0, ply),
    prompt: RECALL_PROMPTS[kind],
    options: shuffled([{ id: line.id, label: answer }, ...distractors], rng),
    correctId: line.id,
    explanation: [line.description, plan].filter((text): text is string => text !== null && text.trim() !== "").join(" ")
  };
}

/**
 * Lines whose recall position identifies them: no other line of the same side reaches it (as its
 * own recall position or on the way to another one).
 */
export function recallCandidates(lines: readonly Line[]): Line[] {
  return lines.filter((line) => {
    const epd = toEpd(recallFen(line));
    return !lines.some((other) => other.id !== line.id && other.side === line.side && other.epds.includes(epd));
  });
}

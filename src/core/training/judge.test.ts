import { describe, expect, it } from "vitest";
import { applyMove, type AppliedMove } from "../chess/position";
import type { CompiledNote } from "../content/types";
import type { AnalysedLine, Explanation, MoveScore } from "../engine/types";
import {
  MISTAKE_LOSS,
  SOUND_LOSS,
  VERDICT_LABELS,
  feedbackSentence,
  isWrongTry,
  judgeMove,
  needsEngine,
  withEngine,
  type JudgeInput
} from "./judge";
import { lastMove, makeLine, makeNote, makeTree, playMoves } from "./testing";
import type { MoveJudgement, Verdict } from "./types";

const VERDICTS: Verdict[] = ["book", "alternative", "inaccuracy", "mistake", "unverified"];

// White repertoire: after 1.c4 e5 the main line plays 2.Nc3, a secondary line 2.g3.
const MAIN = makeLine({ id: "eng-main", side: "white", moves: "1.c4 e5 2.Nc3", priority: "main", order: 1 });
const SECOND = makeLine({ id: "eng-g3", side: "white", moves: "1.c4 e5 2.g3", priority: "secondary", order: 2 });
const TREE = makeTree("white", [MAIN, SECOND]);
const NODE = TREE.nodes.get(MAIN.epds[2])!;
const SIBLINGS = NODE.edges.filter((edge) => edge.mover === "user");
const NC3 = MAIN.moves[2];
const FEN = NC3.fenBefore;

const NOTE: CompiledNote = makeNote(NC3, {
  alternatives: [{ san: "Nf3", note: "Also develops; it often transposes." }],
  mistakes: [
    { san: "Qa4", note: "The queen comes out too early and is chased.", severity: "mistake" },
    { san: "b4", note: "Loosens the queenside for nothing.", severity: "inaccuracy" },
    { san: "g3", note: "Listed as a mistake by mistake.", severity: "mistake" }
  ]
});

function play(san: string): AppliedMove {
  const move = applyMove(FEN, san);
  if (!move) {
    throw new Error(`${san} is not legal`);
  }
  return move;
}

function judge(san: string, overrides: Partial<JudgeInput> = {}): MoveJudgement {
  return judgeMove({ move: play(san), expected: [{ uci: NC3.uci, san: NC3.san }], siblings: SIBLINGS, note: NOTE, ...overrides });
}

function analysed(uci: string, winPct: number): AnalysedLine {
  return { uci, cp: 0, mate: null, winPct, depth: 16, pv: [uci], san: uci, pvSan: [uci] };
}

function scoreOf(move: AppliedMove, loss: number): MoveScore {
  return { fen: move.fenBefore, uci: move.uci, best: analysed("b1c3", 55), played: analysed(move.uci, 55 - loss), loss, depth: 16 };
}

const EXPLANATION: Explanation = { tone: "neutral", headline: "Playable but less accurate: it gives away part of your position.", details: [] };

describe("judgeMove", () => {
  it("the expected move is a book move from the repertoire", () => {
    expect(judge("Nc3")).toEqual({
      verdict: "book",
      source: "repertoire",
      san: "Nc3",
      uci: "b1c3",
      note: null,
      otherLineIds: [],
      loss: null,
      explanation: null
    });
  });

  it("any of several expected moves is a book move", () => {
    const expected = SIBLINGS.map((edge) => ({ uci: edge.uci, san: edge.san }));
    expect(judge("g3", { expected }).verdict).toBe("book");
    expect(judge("Nc3", { expected }).verdict).toBe("book");
  });

  it("another enabled line's move here is an acceptable alternative (other-line), even if the content lists it as a mistake", () => {
    expect(judge("g3")).toMatchObject({ verdict: "alternative", source: "other-line", otherLineIds: ["eng-g3"], note: null, loss: null });
  });

  it("an alternative listed in the content is an acceptable alternative (content) with its note", () => {
    expect(judge("Nf3")).toMatchObject({ verdict: "alternative", source: "content", note: "Also develops; it often transposes.", otherLineIds: [] });
  });

  it("a mistake listed in the content is a mistake or an inaccuracy, as its severity says", () => {
    expect(judge("Qa4")).toMatchObject({ verdict: "mistake", source: "content", note: "The queen comes out too early and is chased." });
    expect(judge("b4")).toMatchObject({ verdict: "inaccuracy", source: "content", note: "Loosens the queenside for nothing." });
  });

  it("an unknown legal move is unverified, never an inaccuracy or a mistake", () => {
    const unknown = ["h4", "a3", "Qb3", "d4", "f4", "Na3"].map((san) => judge(san));
    for (const judgement of unknown) {
      expect(judgement).toMatchObject({ verdict: "unverified", source: "none", note: null, loss: null, explanation: null });
      expect(needsEngine(judgement)).toBe(true);
    }
    // Without a note or siblings, every non-book move is unverified.
    for (const san of ["Qa4", "b4", "Nf3", "g3"]) {
      expect(judge(san, { note: null, siblings: [] }).verdict).toBe("unverified");
    }
  });

  it("a note written for another position is ignored", () => {
    const elsewhere = { ...NOTE, epdBefore: MAIN.epds[0] };
    expect(judge("Qa4", { note: elsewhere }).verdict).toBe("unverified");
    expect(judge("Nf3", { note: elsewhere }).verdict).toBe("unverified");
  });

  it("matches content SAN without check marks", () => {
    const { move } = lastMove("1.e4 e5 2.Bc4 Nc6 3.Bxf7+");
    expect(move.san).toBe("Bxf7+");
    const expected = applyMove(move.fenBefore, "Nf3")!;
    const note = makeNote(expected, { mistakes: [{ san: "Bxf7", note: "Gives a bishop for a pawn.", severity: "mistake" }] });
    expect(judgeMove({ move, expected: [{ uci: expected.uci, san: expected.san }], siblings: [], note }).verdict).toBe("mistake");
  });

  it("ignores opponent edges passed as siblings", () => {
    const blackNode = TREE.nodes.get(MAIN.epds[1])!;
    const reply = playMoves("1.c4 e5")[1];
    const judgement = judgeMove({ move: reply, expected: [], siblings: blackNode.edges, note: null });
    expect(judgement.verdict).toBe("unverified");
  });
});

describe("withEngine", () => {
  const unverified = judge("h4");
  const h4 = play("h4");

  it("uses the thresholds at their exact boundaries: < 5 alternative, < 10 inaccuracy, from 10 a mistake", () => {
    expect(SOUND_LOSS).toBe(5);
    expect(MISTAKE_LOSS).toBe(10);
    const table: [number, Verdict][] = [
      [0, "alternative"],
      [4.99, "alternative"],
      [5, "inaccuracy"],
      [7.5, "inaccuracy"],
      [9.99, "inaccuracy"],
      [10, "mistake"],
      [42, "mistake"]
    ];
    for (const [loss, verdict] of table) {
      const refined = withEngine(unverified, scoreOf(h4, loss), EXPLANATION);
      expect([loss, refined.verdict]).toEqual([loss, verdict]);
      expect(refined).toMatchObject({ source: "engine", loss, explanation: EXPLANATION, san: "h4", uci: "h2h4" });
      expect(needsEngine(refined)).toBe(false);
    }
  });

  it("treats a negative loss as 0 and keeps the judgement when the loss is not a number", () => {
    expect(withEngine(unverified, scoreOf(h4, -0.3), null)).toMatchObject({ verdict: "alternative", loss: 0, explanation: null });
    expect(withEngine(unverified, scoreOf(h4, Number.NaN), EXPLANATION)).toBe(unverified);
  });

  it("ignores a score for a different move (a stale result)", () => {
    expect(withEngine(unverified, scoreOf(play("a3"), 20), EXPLANATION)).toBe(unverified);
  });

  it("never overrides the repertoire or the content", () => {
    for (const san of ["Nc3", "g3", "Nf3", "Qa4", "b4"]) {
      const judgement = judge(san);
      expect(withEngine(judgement, scoreOf(play(san), 30), EXPLANATION)).toBe(judgement);
      expect(withEngine(judgement, scoreOf(play(san), 0), EXPLANATION)).toBe(judgement);
    }
  });
});

describe("verdict helpers", () => {
  it("only inaccuracies, mistakes and unverified moves are wrong tries", () => {
    expect(VERDICTS.filter(isWrongTry)).toEqual(["inaccuracy", "mistake", "unverified"]);
  });

  it("only unverified judgements need the engine", () => {
    const judgements = ["Nc3", "g3", "Nf3", "Qa4", "b4", "h4"].map((san) => judge(san));
    expect(judgements.filter(needsEngine).map((judgement) => judgement.san)).toEqual(["h4"]);
  });

  it("has a distinct label per verdict", () => {
    expect(VERDICT_LABELS).toEqual({
      book: "Book move",
      alternative: "Acceptable alternative",
      inaccuracy: "Inaccuracy",
      mistake: "Mistake",
      unverified: "Not in your repertoire"
    });
    expect(new Set(Object.values(VERDICT_LABELS)).size).toBe(VERDICTS.length);
  });
});

describe("feedbackSentence", () => {
  const h4 = play("h4");
  const judgements: MoveJudgement[] = [
    judge("Nc3"),
    judge("g3"),
    judge("Nf3"),
    judge("Qa4"),
    judge("b4"),
    judge("h4"),
    withEngine(judge("h4"), scoreOf(h4, 2), null),
    withEngine(judge("h4"), scoreOf(h4, 6), null),
    withEngine(judge("h4"), scoreOf(h4, 20), null)
  ];

  it("is a complete sentence without exclamation marks, for every kind of judgement", () => {
    for (const judgement of judgements) {
      for (const label of [null, "2.Nc3"]) {
        const sentence = feedbackSentence(judgement, label);
        expect(sentence).toMatch(/^[A-Z].*\.$/);
        expect(sentence).not.toMatch(/!/);
      }
    }
  });

  it("never names the expected move until it is revealed, then says to play it", () => {
    for (const judgement of judgements.filter((entry) => entry.verdict !== "book")) {
      const hidden = feedbackSentence(judgement, null);
      expect(hidden).not.toContain("Nc3");
      expect(hidden.endsWith("Try again.")).toBe(true);
      const shown = feedbackSentence(judgement, "2.Nc3");
      expect(shown).toContain("2.Nc3");
      expect(shown.endsWith("Your repertoire move here is 2.Nc3: play it to continue.")).toBe(true);
    }
  });

  it("says what each verdict means", () => {
    const sentences = judgements.map((judgement) => feedbackSentence(judgement, null));
    expect(sentences).toEqual([
      "Correct: that is your repertoire move.",
      "That move belongs to another of your lines; this one asks for a different move. Try again.",
      "That is a sound alternative, but it is not your repertoire move. Try again.",
      "That move is a known mistake here. Try again.",
      "That move is a known inaccuracy here. Try again.",
      "That is not your repertoire move; nothing is said about its quality. Try again.",
      "The engine rates that move as sound, but it is not your repertoire move. Try again.",
      "The engine rates that move as an inaccuracy. Try again.",
      "The engine rates that move as a mistake. Try again."
    ]);
  });

  it("the unverified sentence claims nothing about the move's quality", () => {
    const sentence = feedbackSentence(judge("h4"), null);
    expect(sentence).not.toMatch(/mistake|inaccura|bad|weak|wrong|error/i);
  });

  it("a book move gets the same sentence whether or not the solution was shown", () => {
    expect(feedbackSentence(judge("Nc3"), "2.Nc3")).toBe("Correct: that is your repertoire move.");
  });
});

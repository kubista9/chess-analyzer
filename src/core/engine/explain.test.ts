import { describe, expect, it } from "vitest";
import { START_FEN, applyMove, fenAfter, legalMoves, replayMoves, type AppliedMove } from "../chess/position";
import {
  BALANCE_BANDS,
  EXPLAIN_MISTAKE_LOSS,
  EXPLAIN_SOUND_LOSS,
  EXPLANATION_HEADLINES,
  MAX_DETAILS,
  describeBalance,
  explainMoveScore,
  type ExplainInput
} from "./explain";
import { rootMoveLoss, scoreWinPercent } from "./score";
import type { AnalysedLine, Explanation, MoveScore } from "./types";
import { parseInfoLine, toEngineLine } from "./uci";

// The engine lines below are Stockfish 19 Lite WASM output (the vendored build, run under Node),
// trimmed to the fields the parser reads. Best and played lines of one test come from the same
// root position and depth, as EngineService.scoreMove produces them.

/** An AnalysedLine from a recorded info line, with SAN from replaying its pv. */
function analysed(fen: string, info: string): AnalysedLine {
  const parsed = parseInfoLine(info);
  if (!parsed) {
    throw new Error(`Not an info line: ${info}`);
  }
  const line = toEngineLine(parsed);
  const pvSan = replayMoves(line.pv, fen).map((move) => move.san);
  return { ...line, san: pvSan[0], pvSan };
}

/** The explainMoveScore input for `played` after the SAN moves `before`, scored against `best`. */
function scored(before: readonly string[], best: string, played: string, startFen = START_FEN): ExplainInput {
  const history = replayMoves(before, startFen);
  const fen = history.length > 0 ? history[history.length - 1].fenAfter : startFen;
  const bestLine = analysed(fen, best);
  const playedLine = best === played ? bestLine : analysed(fen, played);
  const move = applyMove(fen, playedLine.uci) as AppliedMove;
  const loss = playedLine.uci === bestLine.uci ? 0 : rootMoveLoss(bestLine, playedLine);
  const score: MoveScore = { fen, uci: move.uci, best: bestLine, played: playedLine, loss, depth: bestLine.depth };
  return { score, move, history };
}

/** Every sentence of an explanation. */
function texts(explanation: Explanation): string[] {
  return [explanation.headline, ...explanation.details];
}

// 1.c4 e5 2.Nc3 Bc5 3.g3 Qf6: Black threatens ...Qxf2#.
const QF6 = ["c4", "e5", "Nc3", "Bc5", "g3", "Qf6"];
const QF6_E3 = "info depth 12 seldepth 18 multipv 1 score cp 91 nodes 95255 pv e2e3 g8e7 f1g2 e8g8 g1e2 d7d6 d2d4 c5b4 e1g1 c7c6";
const QF6_NF3 = "info depth 12 seldepth 15 multipv 2 score cp 87 nodes 95255 pv g1f3 g8e7 f1g2 d7d6 b2b4 c5b6 e1g1 e8g8 a2a4 a7a5";
const QF6_BG2 = "info depth 12 seldepth 3 multipv 1 score mate -1 nodes 33 pv f1g2 f6f2";

// 1.e4 e5 2.Nf3 Nc6 3.Bc4, Black to move.
const ITALIAN = ["e4", "e5", "Nf3", "Nc6", "Bc4"];
const ITALIAN_NF6 = "info depth 14 seldepth 21 multipv 1 score cp -21 nodes 304477 pv g8f6 f3g5 d7d5 e4d5 c6d4 c2c3 d4f5 d2d4 e5d4 e1g1";
const ITALIAN_BC5 = "info depth 14 seldepth 23 multipv 2 score cp -28 nodes 304477 pv f8c5 c2c3 g8f6 d2d4 e5d4 b2b4 c5b6 a2a4 e8g8 e1g1";
const ITALIAN_QE7 = "info depth 14 seldepth 21 multipv 3 score cp -105 nodes 304477 pv d8e7 e1g1 d7d6 d2d4 c8g4 c2c3 g8f6 d4d5 c6b8 h2h3";
const ITALIAN_NF6_B = "info depth 14 seldepth 22 multipv 1 score cp -12 nodes 143696 pv g8f6 d2d3 f8c5 c2c3 e8g8 e1g1 d7d6 f1e1 c5b6 a2a4";
const ITALIAN_B5 = "info depth 14 seldepth 20 multipv 2 score cp -208 nodes 143696 pv b7b5 c4b5 f8c5 b5c6 d7c6 e1g1 f7f6 d2d3 g8e7 c1e3";

// 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 (Two Knights), White to move: the e4-pawn hangs.
const TWO_KNIGHTS = [...ITALIAN, "Nf6"];
const TWO_KNIGHTS_D3 = "info depth 14 seldepth 22 multipv 1 score cp 8 nodes 242168 pv d2d3 f8c5 e1g1 e8g8 c2c3 d7d6 b2b4 c5b6 c4b3";
const TWO_KNIGHTS_D4 = "info depth 14 seldepth 24 multipv 2 score cp 6 nodes 242168 pv d2d4 e5d4 e4e5 d7d5 c4b5 f6e4 f3d4 f8c5 e1g1 c8d7";
const TWO_KNIGHTS_C3 = "info depth 14 seldepth 18 multipv 3 score cp -61 nodes 242168 pv c2c3 f6e4 e1g1 d7d5 c4b5 c8g4 d2d4 e5d4 d1d4 a7a6";
const TWO_KNIGHTS_BB3 = "info depth 14 seldepth 20 multipv 1 score cp -56 nodes 56570 pv c4b3 f6e4 e1g1 d7d5 d2d3 e4c5 f3e5 c6e5 f1e1 c8e6";

// 1.e4 c5 2.Nf3 d6 3.d4 cxd4, White to move: the pawn is to be won back.
const SICILIAN = ["e4", "c5", "Nf3", "d6", "d4", "cxd4"];
const SICILIAN_NXD4 = "info depth 14 seldepth 25 multipv 1 score cp 47 nodes 164702 pv f3d4 g8f6 b1c3 a7a6 c1g5 b8d7 f2f4 g7g6 d1f3 h7h6";
const SICILIAN_A4 = "info depth 14 seldepth 20 multipv 2 score cp -32 nodes 164702 pv a2a4 e7e5 f1c4 d8c7 c4b3 g8f6 c2c3 d4c3 b1c3 f8e7";
const SICILIAN_NXD4_B = "info depth 14 seldepth 23 multipv 1 score cp 50 nodes 64289 pv f3d4 e7e5 d4b3 f8e7 f1c4 g8f6 b1c3 e8g8 c1e3";
const SICILIAN_E5 = "info depth 14 seldepth 20 multipv 2 score cp -142 nodes 64289 pv e4e5 d6e5 c2c3 b8c6 f1b5 d8d5 b5c6 d5c6 c3d4 e5d4";

// Queen's Gambit Declined, the Elephant trap: 6.Nxd5?? Nxd5! 7.Bxd8 Bb4+.
const ELEPHANT = ["d4", "d5", "c4", "e6", "Nc3", "Nf6", "Bg5", "Nbd7", "cxd5", "exd5"];
const ELEPHANT_E3 = "info depth 14 seldepth 26 multipv 1 score cp 33 nodes 175171 pv e2e3 f8e7 f1d3 e8g8 g5f4 f8e8 g1f3 d7f8 f3e5 c7c6";
const ELEPHANT_NXD5 = "info depth 14 seldepth 28 multipv 2 score cp -495 nodes 175171 pv c3d5 f6d5 g5d8 f8b4 d1d2 b4d2 e1d2 e8d8 e2e4 d5e7";

// Ruy Lopez 3...a6: the bishop is attacked.
const RUY = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"];
const RUY_BA4 = "info depth 14 seldepth 25 multipv 1 score cp 34 nodes 218840 pv b5a4 g8f6 e1g1 f6e4 d2d4 b7b5 a4b3 d7d5 d4e5 c8e6";
const RUY_BXC6 = "info depth 14 seldepth 25 multipv 2 score cp 17 nodes 218840 pv b5c6 d7c6 e1g1 d8d6 b1a3 b7b5 c2c4 g8e7 d2d4 e5d4";

describe("describeBalance", () => {
  it("names the five bands from the user's win%", () => {
    expect(describeBalance(85)).toBe("you are clearly better");
    expect(describeBalance(62)).toBe("you are slightly better");
    expect(describeBalance(50)).toBe("the position is roughly equal");
    expect(describeBalance(36)).toBe("you are slightly worse");
    expect(describeBalance(12)).toBe("you are clearly worse");
  });

  it("puts each band edge on the side of the stronger statement, symmetrically", () => {
    expect(describeBalance(BALANCE_BANDS.clearlyBetter)).toBe("you are clearly better");
    expect(describeBalance(69.99)).toBe("you are slightly better");
    expect(describeBalance(BALANCE_BANDS.slightlyBetter)).toBe("you are slightly better");
    expect(describeBalance(57.99)).toBe("the position is roughly equal");
    expect(describeBalance(42.01)).toBe("the position is roughly equal");
    expect(describeBalance(BALANCE_BANDS.slightlyWorse)).toBe("you are slightly worse");
    expect(describeBalance(30.01)).toBe("you are slightly worse");
    expect(describeBalance(BALANCE_BANDS.clearlyWorse)).toBe("you are clearly worse");
    for (const winPct of [0, 10, 30, 35, 42, 45, 50, 58, 64, 70, 100]) {
      const mirrored = describeBalance(100 - winPct);
      const swapped = describeBalance(winPct).replace("better", "WORSE").replace("worse", "better").replace("WORSE", "worse");
      expect(mirrored).toBe(swapped);
    }
  });

  it("handles the ends of the scale and rejects a non-number", () => {
    expect(describeBalance(0)).toBe("you are clearly worse");
    expect(describeBalance(100)).toBe("you are clearly better");
    expect(() => describeBalance(Number.NaN)).toThrow(/Invalid win%/);
    expect(() => describeBalance(Number.POSITIVE_INFINITY)).toThrow(/Invalid win%/);
  });
});

describe("explainMoveScore headlines", () => {
  it("uses the judge's thresholds: sound below 5, a mistake from 10 (win% loss)", () => {
    expect(EXPLAIN_SOUND_LOSS).toBe(5);
    expect(EXPLAIN_MISTAKE_LOSS).toBe(10);
  });

  it("grades by the loss, with the spec's headlines and tones", () => {
    const input = scored(ITALIAN, ITALIAN_NF6, ITALIAN_QE7);
    const at = (loss: number) => explainMoveScore({ ...input, score: { ...input.score, loss } });
    expect(at(0)).toMatchObject({ tone: "good", headline: "Sound: the engine rates it close to its first choice." });
    expect(at(4.99)).toMatchObject({ tone: "good", headline: EXPLANATION_HEADLINES.sound });
    expect(at(5)).toMatchObject({ tone: "warning", headline: "Playable but less accurate: it gives away part of your position." });
    expect(at(9.99)).toMatchObject({ tone: "warning", headline: EXPLANATION_HEADLINES.inaccurate });
    expect(at(10)).toMatchObject({ tone: "bad", headline: "A real mistake: it gives the opponent a clear edge." });
  });

  it("refuses a score that belongs to another move or position, or a broken loss", () => {
    const input = scored(ITALIAN, ITALIAN_NF6, ITALIAN_QE7);
    const other = applyMove(input.move.fenBefore, "f8c5") as AppliedMove;
    expect(() => explainMoveScore({ ...input, move: other })).toThrow(/not for f8c5/);
    const elsewhere = applyMove(START_FEN, "e2e4") as AppliedMove;
    expect(() => explainMoveScore({ ...input, move: elsewhere })).toThrow(/The score is for/);
    expect(() => explainMoveScore({ ...input, score: { ...input.score, loss: -1 } })).toThrow(/Invalid win% loss/);
    expect(() => explainMoveScore({ ...input, score: { ...input.score, loss: Number.NaN } })).toThrow(/Invalid win% loss/);
  });
});

describe("explainMoveScore: a sound alternative", () => {
  it("4.Nf3 against 4.e3: close to the first choice, and what the engine's move does", () => {
    const input = scored(QF6, QF6_E3, QF6_NF3);
    expect(input.score.loss).toBeLessThan(EXPLAIN_SOUND_LOSS);
    expect(explainMoveScore(input)).toEqual({
      tone: "good",
      headline: "Sound: the engine rates it close to its first choice.",
      details: ["The engine's first choice is 4.e3: it stops the mate threat on f2."],
      bestSan: "e3",
      replySan: "Ne7"
    });
  });

  it("3...Bc5 against 3...Nf6, and 4.Bxc6 against 4.Ba4", () => {
    expect(explainMoveScore(scored(ITALIAN, ITALIAN_NF6, ITALIAN_BC5))).toMatchObject({
      tone: "good",
      details: ["The engine's first choice is 3...Nf6: it develops the knight."],
      bestSan: "Nf6",
      replySan: "c3"
    });
    expect(explainMoveScore(scored(RUY, RUY_BA4, RUY_BXC6))).toMatchObject({
      tone: "good",
      details: ["The engine's first choice is 4.Ba4: it moves the bishop out of attack."],
      bestSan: "Ba4"
    });
  });

  it("says so when the move is the engine's own first choice, without a bestSan", () => {
    const explanation = explainMoveScore(scored(QF6, QF6_E3, QF6_E3));
    expect(explanation).toEqual({ tone: "good", headline: EXPLANATION_HEADLINES.sound, details: ["It is the engine's first choice."], replySan: "Ne7" });
  });

  it("calls a sound pawn sacrifice a sacrifice, not a loss", () => {
    // 4.d4 exd4 5.e5: the engine's line here wins the pawn back, so nothing is said about material.
    expect(explainMoveScore(scored(TWO_KNIGHTS, TWO_KNIGHTS_D3, TWO_KNIGHTS_D4)).details).toEqual([
      "The engine's first choice is 4.d3: it protects the pawn on e4."
    ]);
    // The same move with a line that keeps the pawn: a gambit.
    const gambit = "info depth 14 multipv 2 score cp 6 nodes 1 pv d2d4 e5d4 e1g1 f8c5 e4e5 d7d5 e5f6 d5c4 f1e1 c8e6";
    expect(explainMoveScore(scored(TWO_KNIGHTS, TWO_KNIGHTS_D3, gambit)).details[0]).toBe(
      "After 4...exd4 you give up a pawn, but the engine judges that you get enough play for it."
    );
  });
});

describe("explainMoveScore: an inaccuracy", () => {
  it("3...Qe7: the resulting balance, the early queen, and the engine's move", () => {
    const input = scored(ITALIAN, ITALIAN_NF6, ITALIAN_QE7);
    expect(input.score.loss).toBeGreaterThanOrEqual(EXPLAIN_SOUND_LOSS);
    expect(input.score.loss).toBeLessThan(EXPLAIN_MISTAKE_LOSS);
    expect(explainMoveScore(input)).toEqual({
      tone: "warning",
      headline: "Playable but less accurate: it gives away part of your position.",
      details: [
        "After 4.O-O you are slightly worse.",
        "It brings the queen out early, where the opponent's minor pieces can chase it and gain time.",
        "The engine prefers 3...Nf6: it develops the knight."
      ],
      bestSan: "Nf6",
      replySan: "O-O"
    });
  });

  it("says 'still' when the user keeps an edge", () => {
    const input = scored(ITALIAN, ITALIAN_NF6, ITALIAN_QE7);
    const ahead = { ...input.score.played, cp: 200, winPct: scoreWinPercent({ cp: 200, mate: null }) };
    const explanation = explainMoveScore({ ...input, score: { ...input.score, played: ahead, loss: 6 } });
    expect(explanation.details[0]).toBe("After 4.O-O you are still slightly better, though less so than after the engine's choice.");
  });
});

describe("explainMoveScore: material", () => {
  it("4.c3 loses a pawn to 4...Nxe4", () => {
    const explanation = explainMoveScore(scored(TWO_KNIGHTS, TWO_KNIGHTS_D3, TWO_KNIGHTS_C3));
    expect(explanation).toMatchObject({ tone: "warning", bestSan: "d3", replySan: "Nxe4" });
    expect(explanation.details).toEqual(["After 4...Nxe4 you lose a pawn.", "The engine prefers 4.d3: it protects the pawn on e4."]);
  });

  it("4.Bb3 loses the pawn and moves the bishop twice", () => {
    expect(explainMoveScore(scored(TWO_KNIGHTS, TWO_KNIGHTS_D3, TWO_KNIGHTS_BB3)).details).toEqual([
      "After 4...Nxe4 you lose a pawn.",
      "It moves the same piece again while other pieces are still at home.",
      "The engine prefers 4.d3: it protects the pawn on e4."
    ]);
  });

  it("3...b5 is a real mistake that loses a pawn", () => {
    expect(explainMoveScore(scored(ITALIAN, ITALIAN_NF6_B, ITALIAN_B5))).toEqual({
      tone: "bad",
      headline: "A real mistake: it gives the opponent a clear edge.",
      details: ["After 4.Bxb5 you lose a pawn.", "The engine prefers 3...Nf6: it develops the knight."],
      bestSan: "Nf6",
      replySan: "Bxb5"
    });
  });

  it("follows an exchange to its end: the Elephant trap costs a knight for a pawn", () => {
    expect(explainMoveScore(scored(ELEPHANT, ELEPHANT_E3, ELEPHANT_NXD5)).details[0]).toBe(
      "After 6...Nxd5 7.Bxd8 Bb4+ 8.Qd2 Bxd2+ 9.Kxd2 Kxd8 you lose a knight for a pawn."
    );
  });

  it("notices a pawn that is not won back, and names the recapture", () => {
    expect(explainMoveScore(scored(SICILIAN, SICILIAN_NXD4, SICILIAN_A4))).toMatchObject({
      tone: "warning",
      details: [
        "It does not win back the pawn.",
        "An edge pawn move does little for the centre or for development.",
        "The engine prefers 4.Nxd4: it recaptures on d4."
      ]
    });
    expect(explainMoveScore(scored(SICILIAN, SICILIAN_NXD4_B, SICILIAN_E5)).details).toEqual([
      "After 4...dxe5 you lose a pawn.",
      "The engine prefers 4.Nxd4: it recaptures on d4."
    ]);
    expect(explainMoveScore(scored(SICILIAN, SICILIAN_NXD4, SICILIAN_NXD4)).details).toEqual(["It wins back a pawn.", "It is the engine's first choice."]);
  });

  it("does not count material the rest of the line gives back, or an exchange that starts late", () => {
    // 3...h6 4.Nxe5? Qe7 5.Nf3 Qxe4+: the pawn comes back at once.
    const back = "info depth 14 multipv 2 score cp -150 nodes 1 pv h7h6 f3e5 d8e7 e5f3 e7e4 d1e2 e4e2 e1e2";
    expect(explainMoveScore(scored(["e4", "e5", "Nf3"], "info depth 14 multipv 1 score cp -30 nodes 1 pv b8c6 f1b5", back)).details[0]).toBe(
      "After 3.Nxe5 you are slightly worse."
    );
    // A pawn first taken on the line's sixth ply is not put down to the move.
    const late = "info depth 14 multipv 2 score cp -150 nodes 1 pv a7a6 d2d4 d7d6 f1c4 g8f6 d4e5 f6g4";
    expect(explainMoveScore(scored(["e4", "e5", "Nf3"], "info depth 14 multipv 1 score cp -30 nodes 1 pv b8c6 f1b5", late)).details[0]).toBe(
      "After 3.d4 you are slightly worse."
    );
  });

  it("only mentions a gain in a weaker move's line when the move itself takes something", () => {
    // 3...Nb4?! 4.d4 exd4: the pawn is the opponent's to win back, so it is not "won".
    const nb4 = "info depth 12 multipv 2 score cp -204 nodes 1 pv c6b4 d2d4 e5d4 e1g1 b4c6 c2c3";
    expect(explainMoveScore(scored(ITALIAN, ITALIAN_NF6, nb4)).details[0]).toBe("After 4.d4 you are slightly worse.");
    // A pawn grab the engine dislikes: the move itself takes the pawn.
    const grab = "info depth 12 multipv 2 score cp -150 nodes 1 pv d5c4 e2e4 e7e5 g1f3";
    const greedy = explainMoveScore(scored(["d4", "d5", "c4"], "info depth 12 multipv 1 score cp -30 nodes 1 pv e7e6 b1c3", grab));
    expect(greedy.tone).toBe("bad");
    expect(greedy.details[0]).toBe("It wins a pawn, but the opponent gets active play for it.");
    // A knight given for a pawn.
    const sac = "info depth 12 multipv 2 score cp -120 nodes 1 pv f3e5 c6e5 d2d4 e5g6 e4e5 f6e4";
    const ruy = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7"];
    expect(explainMoveScore(scored(ruy, "info depth 12 multipv 1 score cp 30 nodes 1 pv f1e1 b7b5", sac)).details[0]).toBe(
      "After 6...Nxe5 you lose a knight for a pawn."
    );
  });
});

describe("explainMoveScore: mate", () => {
  it("4.Bg2?? allows 4...Qxf2#", () => {
    const input = scored(QF6, QF6_E3, QF6_BG2);
    expect(input.score.loss).toBeGreaterThan(EXPLAIN_MISTAKE_LOSS);
    expect(explainMoveScore(input)).toEqual({
      tone: "bad",
      headline: "A real mistake: it gives the opponent a clear edge.",
      details: ["After 4...Qxf2# you are checkmated.", "The engine prefers 4.e3: it stops the mate threat on f2."],
      bestSan: "e3",
      replySan: "Qxf2#"
    });
  });

  it("reads a mate in one from the rules even when the engine's line shows another reply", () => {
    const odd = "info depth 12 multipv 1 score cp -900 nodes 1 pv f1g2 b8c6";
    expect(explainMoveScore(scored(QF6, QF6_E3, odd)).details[0]).toBe("After 4...Qxf2# you are checkmated.");
  });

  it("shows a longer forced mate from the line, and names one beyond it", () => {
    // 4.Qc2?? Qxf2+ 5.Kd1 Qxf1#.
    const qc2 = "info depth 12 multipv 1 score mate -2 nodes 1 pv d1c2 f6f2 e1d1 f2f1";
    expect(explainMoveScore(scored(QF6, QF6_E3, qc2)).details[0]).toBe("After 4...Qxf2+ 5.Kd1 Qxf1# you are checkmated.");
    const far = "info depth 20 multipv 1 score mate -4 nodes 1 pv d1c2 g8e7";
    expect(explainMoveScore(scored(QF6, QF6_E3, far)).details[0]).toBe("It allows a forced mate in 4.");
  });

  it("explains a mate the user gives or starts, and one the user misses", () => {
    // Fool's mate: 1.f3 e5 2.g4 Qh4#.
    const mate = "info depth 245 multipv 1 score mate 1 nodes 900 pv d8h4";
    expect(explainMoveScore(scored(["f3", "e5", "g4"], mate, mate))).toEqual({
      tone: "good",
      headline: EXPLANATION_HEADLINES.sound,
      details: ["It gives checkmate.", "It is the engine's first choice."]
    });
    // Scholar's mate set-up: 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? and White to play.
    const scholar = ["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6"];
    const qxf7 = "info depth 245 multipv 1 score mate 1 nodes 900 pv h5f7";
    const missed = explainMoveScore(scored(scholar, qxf7, "info depth 245 multipv 2 score cp 300 nodes 900 pv h5e2 d7d5"));
    expect(missed.details).toEqual(["It misses a forced mate.", "The engine prefers 4.Qxf7#: it gives checkmate."]);
    // Two-move mates: 1.e4 f6 2.d4 g5 3.Qh5#, from a position one move earlier.
    const forced = "info depth 30 multipv 1 score mate 2 nodes 9 pv d2d4 g7g5 d1h5";
    expect(explainMoveScore(scored(["e4", "f6"], forced, forced)).details[0]).toBe("It forces mate: 2...g5 3.Qh5#.");
    const startsMate = "info depth 30 multipv 1 score mate 3 nodes 9 pv d2d4";
    expect(explainMoveScore(scored(["e4", "f6"], startsMate, startsMate)).details[0]).toBe("It starts a forced mate in 3.");
  });
});

describe("explainMoveScore: what the engine's move does", () => {
  /** Every legal move of a position in UCI, sorted. */
  function allUci(fen: string): string[] {
    return legalMoves(fen)
      .map((move) => move.uci)
      .sort();
  }

  /** The closing sentence when the engine's line is `bestPv` (UCI) and the user played some other, worse move. */
  function preference(before: readonly string[], bestPv: string, startFen = START_FEN, bestScore = "cp 50"): string | undefined {
    const fen = before.length > 0 ? fenAfter(before, startFen) : startFen;
    const other = allUci(fen).find((uci) => uci !== bestPv.split(" ")[0]) as string;
    const best = `info depth 12 multipv 1 score ${bestScore} nodes 1 pv ${bestPv}`;
    const played = `info depth 12 multipv 2 score cp -100 nodes 1 pv ${other}`;
    return explainMoveScore(scored(before, best, played, startFen)).details.at(-1);
  }

  const ITALIAN_BC5_D3 = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "d3", "Nf6"];
  const FORK = ["e4", "e5", "Nf3", "Nc6", "Nc3", "Bc5", "Nxe5", "Nxe5"];
  const GAMBIT_PV = "d2d4 e5d4 e1g1 f8c5 e4e5 d7d5 e5f6 d5c4 f1e1 c8e6";

  it.each([
    ["castles", ITALIAN_BC5_D3, "e1g1 d7d6", "The engine prefers 5.O-O: it castles and brings your king to safety."],
    ["wins material", ["e4", "e5", "Nf3", "Qg5"], "f3g5 g8f6", "The engine prefers 3.Nxg5: it wins the queen."],
    ["gives up a pawn for play", TWO_KNIGHTS, GAMBIT_PV, "The engine prefers 4.d4: it gives up a pawn for active play."],
    ["forks", FORK, "d2d4", "The engine prefers 5.d4: it attacks both the bishop on c5 and the knight on e5."],
    ["takes", ["e4", "d5"], "e4d5 d8d5", "The engine prefers 2.exd5: it takes the pawn on d5."],
    ["prepares a fianchetto", ["Nf3", "d5"], "g2g3 g8f6", "The engine prefers 2.g3: it prepares to fianchetto the bishop."],
    ["fights for the centre", ["Nf3", "d5"], "d2d4 g8f6", "The engine prefers 2.d4: it fights for the centre."]
  ])("%s", (_name, before, bestPv, expected) => {
    expect(preference(before, bestPv)).toBe(expected);
  });

  it.each([
    ["gives check", "4k3/8/8/8/8/8/8/3QK3 w - - 0 1", "d1a4", "cp 50", "The engine prefers 1.Qa4+: it gives check."],
    ["improves the king", "4k3/8/8/8/8/8/8/3QK3 w - - 0 1", "e1e2", "cp 50", "The engine prefers 1.Ke2: it improves the king's position."],
    ["activates a rook", "4k3/8/8/8/8/8/8/R3K3 w - - 0 1", "a1a7", "cp 50", "The engine prefers 1.Ra7: it brings the rook to a more active square."],
    ["gains space", "4k3/8/8/8/8/8/P7/4K3 w - - 0 1", "a2a4", "cp 50", "The engine prefers 1.a4: it gains space on the queenside."],
    ["gives checkmate", "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", "a1a8", "mate 1", "The engine prefers 1.Ra8#: it gives checkmate."],
    ["starts a mate", "6k1/5ppp/8/8/8/8/8/RR4K1 w - - 0 1", "b1b7", "mate 2", "The engine prefers 1.Rb7: it starts a forced mate in 2."]
  ])("%s (from a FEN)", (_name, fen, bestPv, bestScore, expected) => {
    expect(preference([], bestPv, fen, bestScore)).toBe(expected);
  });
});

describe("explainMoveScore details", () => {
  it("keeps at most MAX_DETAILS sentences, dropping principle notes before the engine's move", () => {
    // 1.e4 e5 2.Bc4 Nc6 3.Bd3?!: the same piece twice, and it blocks the d-pawn.
    const best = "info depth 12 multipv 1 score cp 40 nodes 1 pv g1f3 g8f6";
    const played = "info depth 12 multipv 2 score cp -20 nodes 1 pv c4d3 g8f6 g1f3";
    const explanation = explainMoveScore(scored(["e4", "e5", "Bc4", "Nc6"], best, played));
    expect(explanation.details).toHaveLength(MAX_DETAILS);
    expect(explanation.details).toEqual([
      "After 3...Nf6 the position is roughly equal.",
      "It moves the same piece again while other pieces are still at home.",
      "The engine prefers 3.Nf3: it develops the knight."
    ]);
  });

  it("leaves principle notes out of a sound move's explanation", () => {
    // The same move, rated close to the best.
    const best = "info depth 12 multipv 1 score cp 40 nodes 1 pv g1f3 g8f6";
    const played = "info depth 12 multipv 2 score cp 30 nodes 1 pv c4d3 g8f6 g1f3";
    const explanation = explainMoveScore(scored(["e4", "e5", "Bc4", "Nc6"], best, played));
    expect(explanation.details).toEqual(["The engine's first choice is 3.Nf3: it develops the knight."]);
  });

  it("leaves out the engine's move on request but still reports bestSan", () => {
    const input = scored(QF6, QF6_E3, QF6_BG2);
    const explanation = explainMoveScore({ ...input, showBest: false });
    expect(explanation.details).toEqual(["After 4...Qxf2# you are checkmated."]);
    expect(explanation.bestSan).toBe("e3");
  });

  it("numbers moves from the FEN when there is no history from the start", () => {
    const fen = fenAfter(QF6);
    const input = scored([], QF6_E3, QF6_BG2, fen);
    expect(input.history).toEqual([]);
    expect(explainMoveScore(input).details).toEqual(["After 4...Qxf2# you are checkmated.", "The engine prefers 4.e3: it stops the mate threat on f2."]);
    const reset = scored([], QF6_E3, QF6_BG2, fen.replace(/ 1 4$/, " 0 1"));
    expect(explainMoveScore(reset).details[0]).toBe("After 1...Qxf2# you are checkmated.");
  });

  it("gives no reply SAN when the line has only the move", () => {
    const input = scored(ITALIAN, ITALIAN_NF6, "info depth 14 multipv 3 score cp -105 nodes 1 pv d8e7");
    const explanation = explainMoveScore(input);
    expect(explanation.replySan).toBeUndefined();
    expect(explanation.details[0]).toBe("With best play you are slightly worse.");
  });

  it("never shows a raw evaluation", () => {
    const inputs = [
      scored(QF6, QF6_E3, QF6_NF3),
      scored(QF6, QF6_E3, QF6_BG2),
      scored(ITALIAN, ITALIAN_NF6, ITALIAN_BC5),
      scored(ITALIAN, ITALIAN_NF6, ITALIAN_QE7),
      scored(ITALIAN, ITALIAN_NF6_B, ITALIAN_B5),
      scored(TWO_KNIGHTS, TWO_KNIGHTS_D3, TWO_KNIGHTS_C3),
      scored(TWO_KNIGHTS, TWO_KNIGHTS_D3, TWO_KNIGHTS_BB3),
      scored(SICILIAN, SICILIAN_NXD4, SICILIAN_A4),
      scored(ELEPHANT, ELEPHANT_E3, ELEPHANT_NXD5),
      scored(RUY, RUY_BA4, RUY_BXC6)
    ];
    for (const input of inputs) {
      for (const text of texts(explainMoveScore(input))) {
        expect(text).not.toMatch(/centipawn|\bcp\b|win%|%|[+-]\d+(\.\d+)?\b|\d+\.\d\d|\bmate -?\d/i);
        expect(text).toMatch(/^[A-Z].*[.]$/);
      }
    }
  });
});

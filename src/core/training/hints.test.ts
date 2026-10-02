import { describe, expect, it } from "vitest";
import { bareSan } from "../chess/format";
import { applyMove, type AppliedMove } from "../chess/position";
import { IDEAS } from "../content/schema";
import {
  IDEA_HINTS,
  MIN_REVEAL_AFTER,
  buildHintSet,
  hintsShown,
  newLadder,
  onWrongTry,
  outcomeOf,
  requestHint,
  requestSolution,
  resultOf,
  resultScore,
  revealThreshold
} from "./hints";
import { isWrongTry } from "./judge";
import { lastMove, makeNote } from "./testing";
import type { LadderState, Outcome, Result, Verdict } from "./types";

const SQUARE = /\b[a-h][1-8]\b/i;

/** Applies wrong tries and hint requests in order: "w" = wrong try, "h" = hint, "s" = solution. */
function ladderAfter(steps: string, revealAfter = 3): LadderState {
  let state = newLadder();
  for (const step of steps) {
    state = step === "w" ? onWrongTry(state, revealAfter) : step === "h" ? requestHint(state) : requestSolution(state);
  }
  return state;
}

describe("the hint ladder", () => {
  it("starts with nothing shown", () => {
    expect(newLadder()).toEqual({ wrongTries: 0, level: 0, hintsRequested: 0, revealed: false, solutionRequested: false });
    expect(hintsShown(newLadder())).toBe(0);
  });

  it("wrong try 1 shows the idea, 2 the piece or area, 3 the solution (default revealAfter 3)", () => {
    const one = onWrongTry(newLadder(), 3);
    expect(one).toMatchObject({ wrongTries: 1, level: 1, revealed: false, hintsRequested: 0 });
    const two = onWrongTry(one, 3);
    expect(two).toMatchObject({ wrongTries: 2, level: 2, revealed: false });
    const three = onWrongTry(two, 3);
    expect(three).toMatchObject({ wrongTries: 3, level: 3, revealed: true, solutionRequested: false });
    expect(hintsShown(three)).toBe(2);
  });

  it("never reveals before MIN_REVEAL_AFTER wrong tries, whatever the setting", () => {
    expect(MIN_REVEAL_AFTER).toBe(3);
    for (const revealAfter of [-1, 0, 1, 2, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(ladderAfter("ww", revealAfter)).toMatchObject({ level: 2, revealed: false });
      expect(ladderAfter("www", revealAfter)).toMatchObject({ level: 3, revealed: true });
    }
    expect(revealThreshold(2)).toBe(3);
    expect(revealThreshold(Number.POSITIVE_INFINITY)).toBe(3);
  });

  it("reveals at revealAfter when it is higher, staying on hint 2 until then", () => {
    expect(ladderAfter("www", 5)).toMatchObject({ wrongTries: 3, level: 2, revealed: false });
    expect(ladderAfter("wwww", 5)).toMatchObject({ wrongTries: 4, level: 2, revealed: false });
    expect(ladderAfter("wwwww", 5)).toMatchObject({ wrongTries: 5, level: 3, revealed: true });
    // A fractional setting rounds up.
    expect(ladderAfter("www", 3.5).revealed).toBe(false);
    expect(ladderAfter("wwww", 3.5).revealed).toBe(true);
  });

  it("the user may ask for the next hint at any time, up to hint 2", () => {
    const one = requestHint(newLadder());
    expect(one).toMatchObject({ level: 1, hintsRequested: 1, wrongTries: 0, revealed: false });
    const two = requestHint(one);
    expect(two).toMatchObject({ level: 2, hintsRequested: 2 });
    // Past hint 2 only the solution is left: no change.
    expect(requestHint(two)).toBe(two);
    const revealed = requestSolution(two);
    expect(requestHint(revealed)).toBe(revealed);
  });

  it("asked hints and wrong tries share the ladder without going back down", () => {
    // A wrong try after two asked hints keeps hint 2.
    expect(ladderAfter("hhw")).toMatchObject({ level: 2, wrongTries: 1, hintsRequested: 2, revealed: false });
    // A hint after a wrong try moves on to hint 2.
    expect(ladderAfter("wh")).toMatchObject({ level: 2, wrongTries: 1, hintsRequested: 1 });
    // A wrong try after one asked hint: try 1 maps to level 1, which is already shown.
    expect(ladderAfter("hw")).toMatchObject({ level: 1, wrongTries: 1, hintsRequested: 1 });
    // Wrong tries still reveal on the third one.
    expect(ladderAfter("hhww")).toMatchObject({ level: 2, revealed: false });
    expect(ladderAfter("hhwww")).toMatchObject({ level: 3, revealed: true, solutionRequested: false });
  });

  it("requestSolution shows the solution at once and records the request", () => {
    expect(requestSolution(newLadder())).toEqual({ wrongTries: 0, level: 3, hintsRequested: 0, revealed: true, solutionRequested: true });
    expect(requestSolution(ladderAfter("wh"))).toMatchObject({ level: 3, revealed: true, solutionRequested: true, wrongTries: 1 });
    // Already shown after too many wrong tries: nothing to ask for.
    const shown = ladderAfter("www");
    expect(requestSolution(shown)).toBe(shown);
    expect(shown.solutionRequested).toBe(false);
  });

  it("alternatives never escalate: only wrong-try verdicts climb the ladder", () => {
    const verdicts: Verdict[] = ["alternative", "alternative", "alternative", "unverified", "alternative", "book"];
    let state = newLadder();
    for (const verdict of verdicts) {
      if (isWrongTry(verdict)) {
        state = onWrongTry(state, 3);
      }
    }
    expect(state).toMatchObject({ wrongTries: 1, level: 1, revealed: false });
    expect(resultOf(state)).toBe("retried");
    // Only alternatives: the exercise is still clean.
    let alternativesOnly = newLadder();
    for (let index = 0; index < 10; index += 1) {
      if (isWrongTry("alternative")) {
        alternativesOnly = onWrongTry(alternativesOnly, 3);
      }
    }
    expect(alternativesOnly).toEqual(newLadder());
  });
});

describe("resultOf and outcomeOf", () => {
  it("map every reachable ladder to its result and outcome", () => {
    const table: [string, Result, Outcome][] = [
      ["", "clean", "good"],
      ["h", "hinted", "hard"],
      ["hh", "hinted", "again"],
      ["hhh", "hinted", "again"],
      ["w", "retried", "hard"],
      ["hw", "retried", "hard"],
      ["ww", "retried", "again"],
      ["wh", "retried", "again"],
      ["hhw", "retried", "again"],
      ["www", "revealed", "again"],
      ["s", "revealed", "again"],
      ["hs", "revealed", "again"],
      ["ws", "revealed", "again"],
      ["hhwws", "revealed", "again"]
    ];
    for (const [steps, result, outcome] of table) {
      const state = ladderAfter(steps);
      expect([steps, resultOf(state), outcomeOf(state)]).toEqual([steps, result, outcome]);
    }
  });

  it("follow the precedence revealed > retried > hinted > clean for every raw combination", () => {
    for (const wrongTries of [0, 1, 2, 3, 4]) {
      for (const level of [0, 1, 2, 3] as const) {
        for (const revealed of [false, true]) {
          for (const hintsRequested of [0, 1, 2]) {
            const state: LadderState = { wrongTries, level, hintsRequested, revealed, solutionRequested: false };
            const result = resultOf(state);
            const outcome = outcomeOf(state);
            if (revealed) {
              expect(result).toBe("revealed");
            } else if (wrongTries > 0) {
              expect(result).toBe("retried");
            } else if (level >= 1) {
              expect(result).toBe("hinted");
            } else {
              expect(result).toBe("clean");
            }
            if (result === "clean") {
              expect(outcome).toBe("good");
            } else if (revealed || level >= 2) {
              expect(outcome).toBe("again");
            } else {
              expect(outcome).toBe("hard");
            }
          }
        }
      }
    }
  });

  it("scores results for mastery", () => {
    expect(resultScore("clean")).toBe(1);
    expect(resultScore("hinted")).toBe(0.6);
    expect(resultScore("retried")).toBe(0.4);
    expect(resultScore("revealed")).toBe(0);
  });
});

/** Moves of every piece type, both colours, captures, checks, castling both ways and a promotion. */
const MOVES: { name: string; move: AppliedMove; history: AppliedMove[]; ply: number }[] = [
  ["white central pawn", "1.e4"],
  ["white c-pawn", "1.c4"],
  ["white flank pawn", "1.a4"],
  ["white fianchetto pawn", "1.g3"],
  ["white pawn capture", "1.e4 d5 2.exd5"],
  ["black pawn", "1.e4 c5"],
  ["black knight", "1.e4 Nf6"],
  ["white knight", "1.Nf3"],
  ["disambiguated knight", "1.d4 d5 2.Nf3 Nf6 3.Nbd2"],
  ["white bishop", "1.e4 e5 2.Bc4"],
  ["fianchetto bishop", "1.g3 d5 2.Bg2"],
  ["bishop capture with check", "1.e4 e5 2.Bc4 Nc6 3.Bxf7+"],
  ["white rook", "1.h4 d5 2.Rh3"],
  ["black rook", "1.e4 a5 2.d4 Ra6"],
  ["white queen", "1.e4 e5 2.Qh5"],
  ["queen recapture", "1.e4 d5 2.exd5 Qxd5"],
  ["black queen", "1.e4 d5 2.exd5 Qxd5 3.Nc3 Qa5"],
  ["white king", "1.e4 e5 2.Ke2"],
  ["black king", "1.e4 e5 2.Qh5 Ke7"],
  ["short castling", "1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.O-O"],
  ["black short castling", "1.e4 e5 2.Nf3 Nf6 3.Bc4 Bc5 4.Nc3 O-O"],
  ["long castling", "1.d4 d5 2.Nc3 Nc6 3.Bf4 Bf5 4.Qd2 Qd7 5.O-O-O"]
].map(([name, movetext]) => ({ name, ...lastMove(movetext) }));

const promotion = applyMove("8/P7/8/8/8/8/8/k6K w - - 0 1", "a7a8q")!;
MOVES.push({ name: "promotion", move: promotion, history: [], ply: 1 });

/** Fails when a hint text gives the move away. */
function expectNoGiveaway(text: string, move: AppliedMove, context: string): void {
  const lower = text.toLowerCase();
  expect(lower.includes(bareSan(move.san).toLowerCase()), `${context}: "${text}" contains ${move.san}`).toBe(false);
  expect(text.includes(move.san), `${context}: "${text}" contains ${move.san}`).toBe(false);
  if (move.castle) {
    expect(/castl|o-o|0-0/i.test(text), `${context}: "${text}" mentions castling`).toBe(false);
  } else {
    expect(new RegExp(`\\b${move.to}\\b`, "i").test(text), `${context}: "${text}" names ${move.to}`).toBe(false);
  }
}

describe("hint texts", () => {
  it("the generic idea hints name no square, no move and no castling", () => {
    for (const idea of IDEAS) {
      const text = IDEA_HINTS[idea];
      expect(text.length).toBeGreaterThan(20);
      expect(SQUARE.test(text), `${idea}: ${text}`).toBe(false);
      expect(/castl|O-O|\b[KQRBN][a-h]?[1-8]?x?[a-h][1-8]\b/.test(text), `${idea}: ${text}`).toBe(false);
      expect(text.endsWith("?") || text.endsWith(".")).toBe(true);
      expect(text).not.toMatch(/!/);
    }
  });

  it("generated hints never contain the move's SAN or target square, for every idea and piece type", () => {
    for (const { name, move, history, ply } of MOVES) {
      const guessed = buildHintSet({ move, history, note: null, ply });
      expectNoGiveaway(guessed.idea, move, `${name} (guessed idea)`);
      expectNoGiveaway(guessed.narrow, move, `${name} (narrow)`);
      for (const idea of IDEAS) {
        const set = buildHintSet({ move, history, note: makeNote(move, { idea }), ply });
        expect(set.idea).toBe(IDEA_HINTS[idea]);
        expectNoGiveaway(set.idea, move, `${name} (${idea})`);
        expectNoGiveaway(set.narrow, move, `${name} (${idea}, narrow)`);
      }
    }
  });

  it("the level-2 hint names the piece and its square, or the kind of move and its area", () => {
    const hint = (movetext: string) => {
      const { move, history, ply } = lastMove(movetext);
      return buildHintSet({ move, history, note: null, ply });
    };
    expect(hint("1.Nf3").narrow).toBe("Look at your knight on g1.");
    expect(hint("1.e4 e5 2.Bc4").narrow).toBe("Look at your bishop on f1.");
    expect(hint("1.e4 e5 2.Qh5").narrow).toBe("Look at your queen on d1.");
    expect(hint("1.e4 e5 2.Ke2").narrow).toBe("Look at your king on e1.");
    expect(hint("1.e4").narrow).toBe("The move is a pawn move in the centre.");
    expect(hint("1.c4").narrow).toBe("The move is a pawn move in the centre.");
    expect(hint("1.a4").narrow).toBe("The move is a pawn move on the queenside.");
    expect(hint("1.g3").narrow).toBe("The move is a pawn move on the kingside.");
    expect(hint("1.e4 d5 2.exd5").narrow).toBe("The move is a pawn capture in the centre.");
    expect(hint("1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.O-O").narrow).toBe("Your king wants to get safe on the kingside.");
    expect(hint("1.d4 d5 2.Nc3 Nc6 3.Bf4 Bf5 4.Qd2 Qd7 5.O-O-O").narrow).toBe("Your king wants to get safe on the queenside.");
  });

  it("marks the piece's square for the level-2 hint (the king's square when castling)", () => {
    for (const { move, history, ply } of MOVES) {
      expect(buildHintSet({ move, history, note: null, ply }).narrowSquares).toEqual([move.from]);
    }
    const castle = MOVES.find((entry) => entry.name === "black short castling")!;
    expect(buildHintSet({ ...castle, note: null }).narrowSquares).toEqual(["e8"]);
  });

  it("the first hint follows the move's likely idea without a note", () => {
    const idea = (movetext: string) => {
      const { move, history, ply } = lastMove(movetext);
      return buildHintSet({ move, history, note: null, ply }).idea;
    };
    expect(idea("1.Nf3")).toBe(IDEA_HINTS.development);
    expect(idea("1.e4")).toBe(IDEA_HINTS.centre);
    expect(idea("1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.O-O")).toBe(IDEA_HINTS["king-safety"]);
    expect(idea("1.e4 d5 2.exd5 Qxd5")).toBe(IDEA_HINTS.recapture);
    expect(idea("1.a4")).toBe(IDEA_HINTS.flank);
  });

  it("content text wins over generated text", () => {
    const { move, history, ply } = lastMove("1.c4");
    const note = makeNote(move, {
      idea: "centre",
      hint: "Take a share of the centre from the side.",
      narrow: "A queenside pawn can help.",
      why: "Controls d5 from the side.",
      fits: "The English builds pressure on the light squares.",
      avoids: "A fixed pawn centre too early."
    });
    const set = buildHintSet({ move, history, note, ply });
    expect(set.idea).toBe("Take a share of the centre from the side.");
    expect(set.narrow).toBe("A queenside pawn can help.");
    expect(set.solution).toEqual({
      san: "c4",
      uci: "c2c4",
      from: "c2",
      to: "c4",
      label: "1.c4",
      why: "Controls d5 from the side.",
      fits: "The English builds pressure on the light squares.",
      avoids: "A fixed pawn centre too early."
    });
  });

  it("a note with only an idea still gets generated narrow and why texts", () => {
    const { move, history, ply } = lastMove("1.e4 Nf6");
    const set = buildHintSet({ move, history, note: { ...makeNote(move, { idea: "tempo" }), why: "Attacks the pawn on e4." }, ply });
    expect(set.idea).toBe(IDEA_HINTS.tempo);
    expect(set.narrow).toBe("Look at your knight on g8.");
    expect(set.solution.label).toBe("1...Nf6");
    expect(set.solution.why).toBe("Attacks the pawn on e4.");
    expect(set.solution.fits).toBeNull();
    expect(set.solution.avoids).toBeNull();
  });

  it("writes a plain why from the move when there is no note", () => {
    const why = (movetext: string) => {
      const { move, history, ply } = lastMove(movetext);
      return buildHintSet({ move, history, note: null, ply }).solution;
    };
    expect(why("1.Nf3").why).toBe("It develops your knight: another minor piece joins the game.");
    expect(why("1.e4").why).toBe("It takes a share of the centre and opens lines for your pieces.");
    expect(why("1.g3").why).toBe("It prepares to put your bishop on the long diagonal.");
    expect(why("1.g3 d5 2.Bg2").why).toBe("It develops your bishop onto the long diagonal.");
    expect(why("1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.O-O")).toMatchObject({
      label: "4.O-O",
      why: "It brings your king to safety on the kingside and a rook towards the centre."
    });
    expect(why("1.e4 d5 2.exd5").why).toBe("It takes the pawn on d5.");
    expect(why("1.e4 d5 2.exd5 Qxd5").why).toBe("It wins the material back: your queen recaptures on d5.");
    expect(why("1.e4 e5 2.Bc4 Nc6 3.Bxf7+").why).toBe("It takes the pawn on f7. It gives check.");
    expect(why("1.e4 e5 2.Qh5").why).toBe("It finds a better square for your queen.");
    expect(why("1.e4 d5 2.exd5 Qxd5 3.Nc3 Qa5").why).toBe("It finds a better square for your queen. It attacks the knight on c3, gaining time.");
    expect(why("1.a4").why).toBe("It gains space on the queenside.");
    // Developing with a threat: the attacked piece is named.
    expect(why("1.e4 e5 2.Nf3 Nc6 3.Bb5 Nf6 4.d3 Bc5 5.Bg5").why).toBe(
      "It develops your bishop: another minor piece joins the game. It attacks the knight on f6, gaining time."
    );
    for (const { move, history, ply } of MOVES) {
      const text = buildHintSet({ move, history, note: null, ply }).solution.why;
      expect(text).toMatch(/^It .+\.$/);
      expect(text).not.toMatch(/!/);
    }
  });
});

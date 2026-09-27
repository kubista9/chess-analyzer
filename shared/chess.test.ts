import { describe, expect, it } from "vitest";
import { gameId, loadOwnerGames } from "../test/loadFixtures.js";
import { OWNER_USERNAME } from "./constants.js";
import { clamp, normalizeResult, resolvePlayerColor } from "./chess.js";

describe("clamp", () => {
  it("passes values inside the range through", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it("clamps values outside the range", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
    expect(clamp(-1500, -1000, 1000)).toBe(-1000);
  });

  it("returns max when min > max (current behaviour)", () => {
    expect(clamp(5, 10, 0)).toBe(0);
  });
});

describe("normalizeResult", () => {
  it("reads the result of the requested colour", () => {
    expect(normalizeResult("white", "win", "resigned")).toBe("win");
    expect(normalizeResult("black", "win", "resigned")).toBe("loss");
    expect(normalizeResult("black", "checkmated", "win")).toBe("win");
  });

  it.each(["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"])(
    "treats %s as a draw",
    (code) => {
      expect(normalizeResult("white", code, code)).toBe("draw");
    }
  );

  it.each(["checkmated", "resigned", "timeout", "abandoned", "lose"])("treats %s as a loss", (code) => {
    expect(normalizeResult("white", code, "win")).toBe("loss");
  });

  it("treats unknown codes as a loss (current behaviour)", () => {
    expect(normalizeResult("white", "kingofthehill", "win")).toBe("loss");
    expect(normalizeResult("white", "", "")).toBe("loss");
  });

  it("matches the owner's real games", () => {
    const expected: Record<string, string> = {
      "167672140552": "win", // 2.Nf3 Bc5, owner Black, opponent resigned
      "170180310304": "draw", // Albin, timeout vs insufficient material
      "170183655724": "loss", // Anglo-Scandinavian, owner checkmated
      "174004846670": "loss", // transposition pair, game A
      "174085063610": "loss", // transposition pair, game B
      "184313849232": "draw", // timeout vs insufficient material
      "184397818138": "win", // London, owner Black
      "184405952510": "loss" // Scandinavian 3...Qa5, owner checkmated
    };

    const games = loadOwnerGames();
    expect(games.map(gameId).sort()).toEqual(Object.keys(expected).sort());

    for (const game of games) {
      const color = game.white.username.toLowerCase() === "kubista9" ? "white" : "black";
      expect(normalizeResult(color, game.white.result, game.black.result), gameId(game)).toBe(expected[gameId(game)]);
    }
  });
});

describe("resolvePlayerColor", () => {
  it("matches the owner by trimmed, case-insensitive name", () => {
    expect(resolvePlayerColor(OWNER_USERNAME, " Kubista9 ", "someone")).toBe("white");
    expect(resolvePlayerColor(OWNER_USERNAME, "someone", " Kubista9 ")).toBe("black");
    expect(resolvePlayerColor(" Kubista9 ", "KUBISTA9", "someone")).toBe("white");
  });

  it("returns null, not a default colour, when the owner played neither side", () => {
    expect(resolvePlayerColor(OWNER_USERNAME, "opponent-a", "opponent-b")).toBeNull();
    expect(resolvePlayerColor(OWNER_USERNAME, "kubista", "kubista99")).toBeNull();
    expect(resolvePlayerColor("  ", "  ", "someone")).toBeNull();
  });
});

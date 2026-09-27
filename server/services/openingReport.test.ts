import { describe, expect, it } from "vitest";
import { OWNER_USERNAME } from "../../shared/constants.js";
import type { PlayerColor, GameResult } from "../../shared/types.js";
import { loadOwnerGames } from "../../test/loadFixtures.js";
import { deriveMonth } from "./gameDerive.js";
import { buildOpeningReport, scorePercent, type ReportGame } from "./openingReport.js";

function game(color: PlayerColor, result: GameResult, openingName = "English Opening"): ReportGame {
  return { color, result, openingName };
}

// The owner's 8 real games as the importer stores them.
const ownerGames = deriveMonth(OWNER_USERNAME, "2026-09", loadOwnerGames()).games.map(({ record }) => record);

describe("scorePercent", () => {
  it("counts a draw as half a point", () => {
    expect(scorePercent(2, 1, 4)).toBe(62.5);
    expect(scorePercent(0, 2, 2)).toBe(50);
    expect(scorePercent(0, 0, 0)).toBe(0);
  });
});

describe("stored GameRecords", () => {
  it("carry what the report needs from results only", () => {
    const byId = Object.fromEntries(ownerGames.map((entry) => [entry.id, entry]));
    expect(ownerGames).toHaveLength(8);
    expect(byId["184405952510"]).toMatchObject({ color: "black", result: "loss", oppName: "fernando787", plyCount: 127 });
    expect(byId["184405952510"].openingName).toMatch(/^Scandinavian/);
    expect(byId["170183655724"]).toMatchObject({ color: "white", result: "loss", plyCount: 28 });
    expect(byId["167672140552"]).toMatchObject({ color: "black", result: "win" });
    expect(byId["170180310304"]).toMatchObject({ color: "black", result: "draw" });
  });
});

describe("buildOpeningReport", () => {
  it("splits the owner's openings by colour", () => {
    const report = buildOpeningReport(ownerGames);
    const families = (color: string) => report.filter((item) => item.color === color).map((item) => item.openingFamily);

    expect(families("white")).toContain("English");
    expect(families("black")).not.toContain("English");
    expect(families("black")).toContain("Scandinavian");
    expect(families("white")).not.toContain("Scandinavian");

    const english = report.find((item) => item.color === "white" && item.openingFamily === "English")!;
    // 3 losses and a timeout-vs-insufficient draw: the draw counts half, not 0.
    expect(english).toMatchObject({ games: 4, wins: 0, draws: 1, losses: 3, scorePct: 12.5 });
  });

  it("keeps W+D+L equal to games, and the totals per colour", () => {
    const report = buildOpeningReport(ownerGames);
    for (const item of report) {
      expect(item.wins + item.draws + item.losses).toBe(item.games);
    }
    for (const color of ["white", "black"] as const) {
      const reported = report.filter((item) => item.color === color).reduce((sum, item) => sum + item.games, 0);
      expect(reported).toBe(ownerGames.filter((entry) => entry.color === color).length);
    }
  });

  it("keeps one family played with both colours as two items", () => {
    const report = buildOpeningReport([game("white", "win"), game("black", "draw")]);
    expect(report).toEqual([
      { color: "white", openingFamily: "English", games: 1, wins: 1, draws: 0, losses: 0, scorePct: 100 },
      { color: "black", openingFamily: "English", games: 1, wins: 0, draws: 1, losses: 0, scorePct: 50 }
    ]);
  });

  it("sorts White first, then by games, then by name, with no cap", () => {
    const games = [
      game("black", "win", "Sicilian Defense"),
      game("white", "win", "Zukertort Opening"),
      game("white", "win", "Bird Opening"),
      game("white", "win", "London System"),
      game("white", "loss", "London System Accelerated"),
      ...Array.from({ length: 12 }, (_, index) => game("black", "win", `Family ${index}`))
    ];
    const report = buildOpeningReport(games);
    expect(report.slice(0, 4).map((item) => `${item.color} ${item.openingFamily}`)).toEqual([
      "white London",
      "white Bird",
      "white Zukertort",
      "black Family 0"
    ]);
    expect(report).toHaveLength(16);
    expect(buildOpeningReport([...games].reverse())).toEqual(report);
  });
});

import { describe, expect, it } from "vitest";
import type { HistoryGameSummary } from "../../shared/types.js";
import { asArchiveGame, loadOwnerGames } from "../../test/loadFixtures.js";
import { OWNER_USERNAME } from "../../shared/constants.js";
import { playerColorForGame } from "./gameParser.js";
import { summarizeGame } from "./gameSummary.js";
import { buildOpeningReport, scorePercent } from "./openingReport.js";

function summary(overrides: Partial<HistoryGameSummary>): HistoryGameSummary {
  return {
    id: "1",
    url: "",
    opponent: "opponent",
    opponentRating: 1200,
    playerRating: 1200,
    color: "white",
    result: "win",
    openingName: "",
    openingFamily: "English",
    endTime: 0,
    plies: 40,
    timeClass: "blitz",
    ...overrides
  };
}

const ownerSummaries = loadOwnerGames().map((raw) => {
  const game = asArchiveGame(raw);
  return summarizeGame(game, playerColorForGame(game, OWNER_USERNAME)!);
});

describe("scorePercent", () => {
  it("counts a draw as half a point", () => {
    expect(scorePercent(2, 1, 4)).toBe(62.5);
    expect(scorePercent(0, 2, 2)).toBe(50);
    expect(scorePercent(0, 0, 0)).toBe(0);
  });
});

describe("summarizeGame", () => {
  it("summarises the owner's real games from results only", () => {
    const byId = Object.fromEntries(ownerSummaries.map((entry) => [entry.id, entry]));
    expect(byId["184405952510"]).toMatchObject({
      color: "black",
      result: "loss",
      opponent: "fernando787",
      openingFamily: "Scandinavian",
      plies: 127
    });
    expect(byId["170183655724"]).toMatchObject({ color: "white", result: "loss", openingFamily: "English", plies: 28 });
    expect(byId["167672140552"]).toMatchObject({ color: "black", result: "win" });
    expect(byId["170180310304"]).toMatchObject({ color: "black", result: "draw" });
  });
});

describe("buildOpeningReport", () => {
  it("splits the owner's openings by colour", () => {
    const report = buildOpeningReport(ownerSummaries);
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
    const report = buildOpeningReport(ownerSummaries);
    for (const item of report) {
      expect(item.wins + item.draws + item.losses).toBe(item.games);
    }
    for (const color of ["white", "black"] as const) {
      const reported = report.filter((item) => item.color === color).reduce((sum, item) => sum + item.games, 0);
      expect(reported).toBe(ownerSummaries.filter((entry) => entry.color === color).length);
    }
  });

  it("keeps one family played with both colours as two items", () => {
    const report = buildOpeningReport([
      summary({ id: "a", color: "white", result: "win" }),
      summary({ id: "b", color: "black", result: "draw" })
    ]);
    expect(report).toEqual([
      { color: "white", openingFamily: "English", games: 1, wins: 1, draws: 0, losses: 0, scorePct: 100 },
      { color: "black", openingFamily: "English", games: 1, wins: 0, draws: 1, losses: 0, scorePct: 50 }
    ]);
  });

  it("sorts White first, then by games, then by name, with no cap", () => {
    const games = [
      summary({ color: "black", openingFamily: "Sicilian" }),
      summary({ color: "white", openingFamily: "Zukertort" }),
      summary({ color: "white", openingFamily: "Bird" }),
      summary({ color: "white", openingFamily: "London" }),
      summary({ color: "white", openingFamily: "London" }),
      ...Array.from({ length: 12 }, (_, index) => summary({ color: "black", openingFamily: `Family ${index}` }))
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

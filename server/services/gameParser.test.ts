import { describe, expect, it } from "vitest";
import type { ArchiveGame } from "../../shared/types.js";
import { gameId, loadArchiveSample, loadOwnerGames, type RawChessComGame } from "../../test/loadFixtures.js";
import { parseGame, playerColorForGame } from "./gameParser.js";

// Only the fields parseGame and playerColorForGame read; the rest are placeholders.
function asArchiveGame(raw: RawChessComGame): ArchiveGame {
  return {
    id: gameId(raw),
    url: raw.url,
    pgn: raw.pgn,
    endTime: raw.end_time,
    timeClass: "blitz",
    timeControl: raw.time_control,
    rated: raw.rated,
    openingName: "",
    openingUrl: raw.eco ?? null,
    openingFamily: "",
    white: { username: raw.white.username, rating: raw.white.rating, result: raw.white.result },
    black: { username: raw.black.username, rating: raw.black.rating, result: raw.black.result }
  };
}

const owner = new Map(loadOwnerGames().map((raw) => [gameId(raw), asArchiveGame(raw)]));
const epd = (fen: string) => fen.split(" ").slice(0, 4).join(" ");

describe("parseGame on the owner's real games", () => {
  it("parses every ply", () => {
    const plies = Object.fromEntries([...owner].map(([id, game]) => [id, parseGame(game).moves.length]));
    expect(plies).toEqual({
      "167672140552": 44,
      "170180310304": 126,
      "170183655724": 28,
      "174004846670": 120,
      "174085063610": 90,
      "184313849232": 177,
      "184397818138": 68,
      "184405952510": 127
    });
  });

  it("records SAN, UCI, colour and FENs per ply", () => {
    const moves = parseGame(owner.get("184405952510")!).moves;
    expect(moves.slice(0, 6).map((move) => move.san)).toEqual(["e4", "d5", "exd5", "Qxd5", "Nc3", "Qa5"]);
    expect(moves[5]).toMatchObject({ ply: 6, moveNumber: 3, uci: "d5a5", color: "black" });
    expect(moves[0].fenBefore).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    expect(moves[1].fenBefore).toBe(moves[0].fenAfter);
  });

  it("sees the transposition pair meet at ply 8 by different move orders", () => {
    const a = parseGame(owner.get("174004846670")!).moves;
    const b = parseGame(owner.get("174085063610")!).moves;
    expect(a.slice(0, 8).map((move) => move.san)).not.toEqual(b.slice(0, 8).map((move) => move.san));
    expect(epd(a[7].fenAfter)).toBe(epd(b[7].fenAfter));
    expect(epd(a[6].fenAfter)).not.toBe(epd(b[6].fenAfter));
  });

  it("ends the Anglo-Scandinavian game in mate", () => {
    const moves = parseGame(owner.get("170183655724")!).moves;
    expect(moves.at(-1)!.san.endsWith("#")).toBe(true);
  });

  it("resolves the owner's colour", () => {
    expect(playerColorForGame(owner.get("184397818138")!, "kubista9")).toBe("black");
    expect(playerColorForGame(owner.get("170183655724")!, "KUBISTA9")).toBe("white");
    expect(playerColorForGame(owner.get("170183655724")!, " Kubista9 ")).toBe("white");
  });

  it("returns null for a player who is on neither side", () => {
    expect(playerColorForGame(owner.get("184397818138")!, "not-a-player-here")).toBeNull();
  });
});

describe("synthetic archive month fixture", () => {
  const { games } = loadArchiveSample();

  it("covers the importer's edge cases", () => {
    expect(games.some((game) => game.rules === "chess960")).toBe(true);
    expect(games.some((game) => game.time_class === "bullet")).toBe(true);
    expect(games.some((game) => game.time_class === "daily")).toBe(true);
    expect(games.some((game) => game.time_class === "rapid" && game.time_control === "600")).toBe(true);
    expect(new Set(games.map(gameId)).size).toBe(games.length - 1);
    expect(
      games.some((game) =>
        [game.white.username, game.black.username].some((name) => name !== "kubista9" && name.trim().toLowerCase() === "kubista9")
      )
    ).toBe(true);
  });

  it("resolves the padded, mixed-case owner name in the synthetic month", () => {
    const padded = games.find((game) =>
      [game.white.username, game.black.username].some((name) => name !== "kubista9" && name.trim().toLowerCase() === "kubista9")
    )!;
    const expected = padded.white.username.trim().toLowerCase() === "kubista9" ? "white" : "black";
    expect(playerColorForGame(asArchiveGame(padded), "kubista9")).toBe(expected);
  });

  it("holds only legal PGNs, including the chess960 start position", () => {
    for (const raw of games) {
      expect(parseGame(asArchiveGame(raw)).moves.length, raw.url).toBeGreaterThan(0);
    }
  });
});

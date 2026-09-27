import { describe, expect, it } from "vitest";
import { START_EPD } from "../../shared/epd.js";
import { gameId, loadArchiveSample, loadOwnerGames, type RawChessComGame } from "../../test/loadFixtures.js";
import { DERIVE_PLY_LIMIT, DERIVE_VERSION, deriveMonth, rawGameSchema, skipReason, utcMonth } from "./gameDerive.js";

const OWNER = "kubista9";

describe("deriveMonth on the synthetic archive month", () => {
  const sample = loadArchiveSample().games;
  const derived = deriveMonth(OWNER, "2026-09", sample);

  it("keeps exactly the blitz game, the padded-name game and the rapid game (3 of 7)", () => {
    expect(derived.games.map((game) => game.record.id)).toEqual(["900000000001", "900000000005", "900000000006"]);
  });

  it("counts every skipped entry under one reason", () => {
    expect(derived.skipped).toEqual({
      variant: 1,
      "custom-start": 0,
      "time-class": 2,
      "not-owner": 0,
      duplicate: 1,
      malformed: 0
    });
    const skipped = Object.values(derived.skipped).reduce((sum, count) => sum + count, 0);
    expect(derived.games.length + skipped).toBe(sample.length);
  });

  it("resolves the owner's colour from a padded, mixed-case username", () => {
    const padded = derived.games.find((game) => game.record.id === "900000000005")!.record;
    expect(padded).toMatchObject({ color: "black", timeClass: "blitz", tc: { base: 180, inc: 2 }, oppName: "synthetic_opp_e" });
    expect(derived.games.find((game) => game.record.id === "900000000006")!.record).toMatchObject({
      color: "white",
      timeClass: "rapid",
      tc: { base: 600, inc: 0 }
    });
  });

  it("does not apply the time window (that is a query filter)", () => {
    const old = { ...sample[0], end_time: 1_000_000_000 };
    expect(deriveMonth(OWNER, "2001-09", [old]).games).toHaveLength(1);
  });
});

describe("skipReason", () => {
  const base = rawGameSchema.parse(loadArchiveSample().games[0]);

  it("treats a SetUp/FEN game with standard rules as a custom start", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    expect(skipReason(OWNER, { ...base, initial_setup: fen })).toBe("custom-start");
    const pgn = base.pgn.replace('[Site "Chess.com"]', `[Site "Chess.com"]\n[SetUp "1"]\n[FEN "${fen}"]`);
    expect(skipReason(OWNER, { ...base, pgn })).toBe("custom-start");
  });

  it("skips games the owner did not play, and never guesses a colour", () => {
    expect(skipReason(OWNER, { ...base, white: { ...base.white, username: "kubista99" } })).toBe("not-owner");
  });

  it("counts a chess960 game as a variant even though it also has SetUp", () => {
    const chess960 = rawGameSchema.parse(loadArchiveSample().games[1]);
    expect(skipReason(OWNER, chess960)).toBe("variant");
  });
});

describe("deriveMonth on the owner's real games", () => {
  const raws = loadOwnerGames();
  const derived = deriveMonth(OWNER, "2026-mixed", raws);
  const byId = new Map(derived.games.map((game) => [game.record.id, game]));

  it("keeps all 8 with ply counts, results and versions", () => {
    expect(derived.games).toHaveLength(8);
    expect(byId.get("184313849232")!.record.plyCount).toBe(177);
    expect(byId.get("170183655724")!.record).toMatchObject({ color: "white", plyCount: 28, deriveVersion: DERIVE_VERSION });
    for (const game of derived.games) {
      expect(game.record.score).toBe(game.record.result === "win" ? 1 : game.record.result === "draw" ? 0.5 : 0);
      expect(game.pgn).toBe(raws.find((raw) => gameId(raw) === game.record.id)!.pgn);
    }
  });

  it("stores the first DERIVE_PLY_LIMIT plies from the standard start", () => {
    for (const game of derived.games) {
      expect(game.plies).toHaveLength(Math.min(DERIVE_PLY_LIMIT, game.record.plyCount));
      expect(game.plies[0]).toMatchObject({ ply: 1, epdBefore: START_EPD });
      expect(game.plies.every((ply) => ply.clockMs !== null && ply.spentMs !== null && ply.spentMs >= 0)).toBe(true);
    }
  });

  it("takes the ECO code from the PGN and the name from the ECO URL", () => {
    const record = byId.get("184405952510")!.record;
    expect(record.eco).toMatch(/^B0\d$/);
    expect(record.openingName).toMatch(/^Scandinavian Defense/);
  });

  it("counts a broken PGN as malformed instead of failing the month", () => {
    const broken = { ...raws[0], url: "https://www.chess.com/game/live/1", uuid: "broken", pgn: '[Event "x"]\n\n1. e4 e4 *' };
    const result = deriveMonth(OWNER, "2026-01", [broken, { url: 42 }]);
    expect(result.games).toHaveLength(0);
    expect(result.skipped.malformed).toBe(2);
  });
});

describe("a large month", () => {
  // CPU-bound (~1.5 s alone: 400 games x 30 replayed plies); allow for parallel test files.
  it("keeps all 400 distinct games (no count cap)", { timeout: 30_000 }, () => {
    const template = loadArchiveSample().games[0];
    const month: RawChessComGame[] = Array.from({ length: 400 }, (_, index) => ({
      ...template,
      url: `https://www.chess.com/game/live/${800_000_000_000 + index}`,
      uuid: `uuid-${index}`,
      end_time: template.end_time + index
    }));
    const derived = deriveMonth(OWNER, "2026-09", month);
    expect(derived.games).toHaveLength(400);
    expect(new Set(derived.games.map((game) => game.record.id)).size).toBe(400);
  });
});

describe("utcMonth", () => {
  it("uses UTC month boundaries", () => {
    expect(utcMonth(Date.parse("2026-08-31T23:59:59Z") / 1000)).toBe("2026-08");
    expect(utcMonth(Date.parse("2026-09-01T00:00:00Z") / 1000)).toBe("2026-09");
  });
});

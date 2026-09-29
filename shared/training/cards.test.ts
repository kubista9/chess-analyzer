import { describe, expect, it } from "vitest";
import { buildRepGraph, cardId, generateCards, mergeCards, type MistakeOccurrence, type RepGraph, type StoredCard } from "./cards.js";
import { DAY_MS, grade, introduce } from "./scheduler.js";
import { entry, epdAfter, repertoire, sansOf } from "../../test/trainingFixtures.js";

const NOW_S = Date.UTC(2026, 8, 26) / 1000;
const NOW_MS = NOW_S * 1000;

const E4_E5_NF3 = ["e2e4", "e7e5", "g1f3"];

function blackRepertoire() {
  return repertoire([
    entry("black", ["e2e4"], "e7e5"),
    entry("black", E4_E5_NF3, "b8c6"),
    entry("black", ["d2d4"], "d7d5"),
    entry("black", ["d2d4", "d7d5", "c2c4"], "e7e6"),
    // Reached by 1.Nf3 d5 2.d4 and by 1.d4 d5 2.Nf3: one entry, one card.
    entry("black", ["g1f3"], "d7d5"),
    entry("black", ["g1f3", "d7d5", "d2d4"], "g8f6"),
    // Not reachable: the repertoire never gets to 1.a3.
    entry("black", ["a2a3", "e7e5", "b2b3"], "d7d5")
  ]);
}

function graphs(): Record<"white" | "black", RepGraph> {
  return { white: buildRepGraph("white", new Map()), black: buildRepGraph("black", blackRepertoire()) };
}

function occurrence(moves: string[], played: string, gameId: string, daysAgo: number, loss = 12): MistakeOccurrence {
  const pathSan = sansOf(moves);
  return {
    color: "black",
    epd: epdAfter(moves),
    pathUci: moves,
    pathSan,
    gameId,
    endTime: NOW_S - daysAgo * 86_400,
    opponent: `opp${gameId}`,
    oppRating: 1200,
    ply: moves.length + 1,
    playedUci: played,
    playedSan: sansOf([...moves, played]).at(-1)!,
    loss
  };
}

function input(occurrences: MistakeOccurrence[] = []) {
  return { graphs: graphs(), occurrences, nodeWeight: () => 3, now: NOW_S, halfLifeDays: 90 };
}

function stored(drafts: ReturnType<typeof generateCards>): StoredCard[] {
  return mergeCards([], drafts, NOW_MS).write;
}

describe("card generation", () => {
  it("makes one line card per reachable owner-to-move entry, once across transpositions", () => {
    const cards = generateCards(input());
    const lines = cards.filter((card) => card.kind === "repertoire-line");
    expect(lines).toHaveLength(6);
    expect(lines.every((card) => card.primary && card.sources.length === 0)).toBe(true);
    expect(cards.some((card) => card.epd === epdAfter(["a2a3", "e7e5", "b2b3"]))).toBe(false);
    const transposed = cards.filter((card) => card.epd === epdAfter(["d2d4", "d7d5", "g1f3"]));
    expect(transposed).toHaveLength(1);
    const nc6 = cards.find((card) => card.epd === epdAfter(E4_E5_NF3))!;
    expect(nc6).toMatchObject({ id: cardId("repertoire-line", "black", nc6.epd), ply: 4, pathSan: ["e4", "e5", "Nf3"], primary: { san: "Nc6" } });
  });

  it("walks prepared replies only and stops at ply 16", () => {
    const graph = graphs().black;
    const replies = graph.moves.get(epdAfter([]))!.map((move) => move.uci).sort();
    expect(replies).toEqual(["d2d4", "e2e4", "g1f3"]);
    expect(buildRepGraph("black", blackRepertoire(), 2).nodes.has(epdAfter(E4_E5_NF3))).toBe(false);
  });

  it("dedupes a mistake site that is a line node into the line card, and groups the rest", () => {
    const cards = generateCards(
      input([
        occurrence(E4_E5_NF3, "f8c5", "g1", 10),
        occurrence(E4_E5_NF3, "f8c5", "g2", 40),
        occurrence(["e2e4", "c7c5", "g1f3"], "a7a6", "g3", 0, 6),
        occurrence(["e2e4", "c7c5", "g1f3"], "f7f5", "g4", 90, 20)
      ])
    );
    const at = (moves: string[]) => cards.filter((card) => card.epd === epdAfter(moves));
    const line = at(E4_E5_NF3);
    expect(line).toHaveLength(1);
    expect(line[0].kind).toBe("repertoire-line");
    expect(line[0].sources.map((source) => source.gameId)).toEqual(["g1", "g2"]);
    const mistake = at(["e2e4", "c7c5", "g1f3"]);
    expect(mistake).toHaveLength(1);
    expect(mistake[0]).toMatchObject({ kind: "own-mistake", primary: null, ply: 4, pathSan: ["e4", "c5", "Nf3"] });
    expect(mistake[0].sources.map((source) => source.gameId)).toEqual(["g3", "g4"]);
    // Recency weights 1 + 0.5 (90 days at H = 90).
    expect(mistake[0].weight).toBeCloseTo(1.5, 3);
    const ids = cards.map((card) => `${card.color}|${card.epd}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is deterministic for reordered input", () => {
    const occurrences = [occurrence(["e2e4", "c7c5", "g1f3"], "b8c6", "a", 3), occurrence(["e2e4", "c7c5", "g1f3"], "b8c6", "b", 3)];
    expect(JSON.stringify(generateCards(input(occurrences)))).toBe(JSON.stringify(generateCards(input([...occurrences].reverse()))));
  });
});

describe("regeneration", () => {
  it("is idempotent and starts mistake cards pending the deep check", () => {
    const drafts = generateCards(input([occurrence(["e2e4", "c7c5", "g1f3"], "b8c6", "a", 3)]));
    const first = mergeCards([], drafts, NOW_MS);
    expect(first.added).toBe(drafts.length);
    expect(first.write.find((card) => card.kind === "own-mistake")!.confirm).toBe("pending");
    expect(first.write.find((card) => card.kind === "repertoire-line")!.confirm).toBe("none");
    const second = mergeCards(first.write, generateCards(input([occurrence(["e2e4", "c7c5", "g1f3"], "b8c6", "a", 3)])), NOW_MS + 5);
    expect(second.write).toEqual([]);
  });

  it("keeps SRS state by id, marks a card that left the repertoire removed, and restores it", () => {
    const cards = stored(generateCards(input()));
    const id = cardId("repertoire-line", "black", epdAfter(E4_E5_NF3));
    const reviewed = cards.map((card) => (card.id === id ? { ...card, srs: grade(card.kind, card.id, introduce(card.srs, NOW_MS), "correct", NOW_MS) } : card));
    const withoutNc6 = new Map(blackRepertoire());
    withoutNc6.delete(epdAfter(E4_E5_NF3));
    const smaller = generateCards({ ...input(), graphs: { white: buildRepGraph("white", new Map()), black: buildRepGraph("black", withoutNc6) } });
    const removed = mergeCards(reviewed, smaller, NOW_MS);
    expect(removed.removed).toBe(1);
    expect(removed.write).toHaveLength(1);
    expect(removed.write[0]).toMatchObject({ id, status: "removed" });
    const after = reviewed.map((card) => (card.id === id ? removed.write[0] : card));
    const back = mergeCards(after, generateCards(input()), NOW_MS);
    expect(back.restored).toBe(1);
    expect(back.write[0]).toMatchObject({ id, status: "active" });
    expect(back.write[0].srs.box).toBe(2);
  });

  it("brings a retired mistake card back when the mistake recurs in a newer game", () => {
    const moves = ["e2e4", "c7c5", "g1f3"];
    let cards = stored(generateCards(input([occurrence(moves, "f7f5", "old", 30)])));
    const id = cardId("own-mistake", "black", epdAfter(moves));
    let srs = introduce(cards.find((card) => card.id === id)!.srs, NOW_MS - 200 * DAY_MS);
    for (let step = 0; step < 4; step += 1) {
      srs = grade("own-mistake", id, srs, "correct", srs.dueAt!);
    }
    expect(srs.retired).toBe(true);
    cards = cards.map((card) => (card.id === id ? { ...card, confirm: "confirmed", srs } : card));
    // An older game than the last review does not reset it.
    const old = mergeCards(cards, generateCards(input([occurrence(moves, "f7f5", "old", 30), occurrence(moves, "f7f5", "older", 199)])), NOW_MS);
    expect(old.recurred).toBe(0);
    // A new game with the same (EPD, move) does.
    const fresh = mergeCards(cards, generateCards(input([occurrence(moves, "f7f5", "old", 30), occurrence(moves, "f7f5", "new", 0)])), NOW_MS);
    expect(fresh.recurred).toBe(1);
    const card = fresh.write.find((item) => item.id === id)!;
    expect(card.srs).toMatchObject({ retired: false, box: 1, dueAt: NOW_MS, lapses: 1 });
    expect(card.sources.map((source) => source.gameId)).toEqual(["new", "old"]);
  });
});

// Generates the drill cards in memory from the store (nothing is written) and prints the counts by
// kind and colour, and today's due list (the stored SRS state where the store has cards, else the
// new cards the daily caps would introduce). Uses the stored repertoire, or an in-memory seed
// when it is empty. Checks: one card per (colour, EPD), every mistake card has a source game and
// a review link, regeneration is idempotent, and on the golden date the position after
// 1.e4 e5 2.Nf3 (when a game of the window went wrong there) accepts 2...Nc6 and not 2...Bc5.
// Read-only (a short-lived engine only reads its version for the engine config).
//
//   npx tsx scripts/verify/verify-cards.ts --asof 2026-09-26
import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import { rootMoveLoss } from "../../shared/eval.js";
import { buildFixList } from "../../shared/fixList.js";
import { buildTree } from "../../shared/openingTree.js";
import { byColor, type RepEntry } from "../../shared/repertoire.js";
import { seedColor, seedFlags } from "../../shared/repertoireSeed.js";
import { acceptableMoves } from "../../shared/training/judge.js";
import { buildRepGraph, epdAfterMoves, generateCards, mergeCards, type StoredCard } from "../../shared/training/cards.js";
import { SCHEDULES, isDue, sessionPriority } from "../../shared/training/scheduler.js";
import type { PlayerColor } from "../../shared/types.js";
import { listCards } from "../../server/db/drills.js";
import { listRepertoire } from "../../server/db/repertoire.js";
import { getDeepEval } from "../../server/db/positions.js";
import { engineConfigKey } from "../../server/engine/engineConfig.js";
import { ENGINE_PROTOCOL, canonicalJson } from "../../server/engine/protocol.js";
import { engineOptions } from "../../server/engine/sharedPool.js";
import { detectEngineId } from "../../server/engine/uci.js";
import { createAnalysisIndex, type EngineView } from "../../server/services/analysisIndex.js";
import { firstErrors } from "../../server/services/drillService.js";
import { loadOpeningBook } from "../../server/services/openingBook.js";
import { DEFAULT_HALF_LIFE_BY_WINDOW, loadTreeGames } from "../../server/services/treeService.js";
import { OWNER, openStoreReadonly, printTable, readAsofWindow } from "./_lib.js";

const GOLDEN_ASOF = "2026-09-26";
const COLORS: PlayerColor[] = ["white", "black"];

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
  }
}

const window = readAsofWindow();
const golden = window.asof === GOLDEN_ASOF && window.days === 183;
const nowMs = window.end * 1000;
const db = openStoreReadonly();
const book = loadOpeningBook();
const halfLifeDays = DEFAULT_HALF_LIFE_BY_WINDOW["6m"];

const built = Object.fromEntries(
  COLORS.map((color) => {
    const games = loadTreeGames(db, OWNER, window, { color, timeClass: null });
    return [color, { color, games, tree: buildTree(games, { color, now: window.end, halfLifeDays, book }) }];
  })
) as Record<PlayerColor, { color: PlayerColor; games: ReturnType<typeof loadTreeGames>; tree: ReturnType<typeof buildTree> }>;

let engine: EngineView | null = null;
let configId: number | null = null;
try {
  const idName = await detectEngineId(engineOptions());
  const row = db
    .prepare("SELECT id FROM engine_configs WHERE engine_version = ? AND protocol_json = ?")
    .get(engineConfigKey(idName).engineVersion, canonicalJson(ENGINE_PROTOCOL)) as { id: number } | undefined;
  configId = row?.id ?? null;
  engine = row ? createAnalysisIndex({ book: () => book, maxPly: OPENING_PLY_LIMIT }).view(db, row.id) : null;
} catch (error) {
  console.log(`No engine: ${error instanceof Error ? error.message : String(error)} (no mistake cards)`);
}

// The stored repertoire, or an in-memory seed when it is empty.
let entries = byColor(listRepertoire(db, OWNER));
let repertoireSource = "stored";
if (!entries.white.size && !entries.black.size) {
  repertoireSource = "seeded in memory (the store's repertoire is empty)";
  const fix = buildFixList([built.white, built.black], engine ?? undefined);
  const flagged = [...fix.items, ...fix.watch];
  const seeded: RepEntry[] = COLORS.flatMap((color) =>
    seedColor({ tree: built[color].tree, lookup: engine?.lookup ?? null, flags: seedFlags(flagged, color), existing: new Map(), book }).map(
      (entry) => ({ ...entry, locked: false, note: null, updatedAt: 0 })
    )
  );
  entries = byColor(seeded);
}

const started = performance.now();
const graphs = { white: buildRepGraph("white", entries.white), black: buildRepGraph("black", entries.black) };
const occurrences = engine ? [...firstErrors(db, built.white.games, engine), ...firstErrors(db, built.black.games, engine)] : [];
const input = {
  graphs,
  occurrences,
  nodeWeight: (color: PlayerColor, epd: string) => built[color].tree.nodes.get(epd)?.wN ?? 0,
  book,
  now: window.end,
  halfLifeDays
};
const drafts = generateCards(input);
const genMs = performance.now() - started;

const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'drill_cards'").get() !== undefined;
const storedCards: StoredCard[] = hasTable ? listCards(db, OWNER) : [];
const merged = mergeCards(storedCards, drafts, nowMs);
const byId = new Map(storedCards.map((card) => [card.id, card]));
for (const card of merged.write) {
  byId.set(card.id, card);
}
const cards = [...byId.values()].filter((card) => card.status === "active");
check(mergeCards([...byId.values()], generateCards(input), nowMs).write.length === 0, "regeneration is not idempotent");
check(JSON.stringify(generateCards(input)) === JSON.stringify(drafts), "the same input gave different cards");

console.log(
  `Window ${window.asof} (${window.days} days, H = ${halfLifeDays}); engine ${engine ? `config #${engine.configId}, ${engine.positions} positions` : "none"}; ` +
    `repertoire ${repertoireSource}: ${entries.white.size} W / ${entries.black.size} B entries; ${occurrences.length} first errors (loss >= 5); ` +
    `generated in ${genMs.toFixed(0)} ms; stored cards ${storedCards.length}.`
);

// Counts by kind and colour.
const countRows = COLORS.map((color) => {
  const of = (kind: StoredCard["kind"]) => cards.filter((card) => card.color === color && card.kind === kind);
  const lines = of("repertoire-line");
  const mistakes = of("own-mistake");
  return {
    color,
    lineCards: lines.length,
    "lines with mistake games": lines.filter((card) => card.sources.length).length,
    mistakeCards: mistakes.length,
    "mistake games": mistakes.reduce((sum, card) => sum + card.sources.length, 0),
    deepChecked: mistakes.filter((card) => configId !== null && getDeepEval(db, configId, card.epd)).length
  };
});
console.log("\nCards by kind and colour:");
printTable(countRows);

// Invariants.
const keys = cards.map((card) => `${card.color}|${card.epd}`);
check(new Set(keys).size === keys.length, "two cards share a (colour, EPD)");
for (const card of cards) {
  check(card.id === `${card.kind}|${card.color}|${card.epd}`, `card id ${card.id} is not kind|color|epd`);
  if (card.kind === "own-mistake") {
    check(card.sources.length > 0, `mistake card ${card.id} has no source game`);
    check(card.sources.every((source) => source.loss >= 5 && source.ply === card.ply), `mistake card ${card.id} has a source below loss 5 or at another ply`);
    check(card.ply <= OPENING_PLY_LIMIT, `mistake card ${card.id} is past ply ${OPENING_PLY_LIMIT}`);
  } else {
    check(card.ply <= 16 && entries[card.color].get(card.epd)?.uci === card.primary?.uci, `line card ${card.id} does not match its entry`);
  }
}

// Today's due list: stored due cards, then the new ones the caps let in (in the service's order).
const due = cards.filter((card) => isDue(card.srs, nowMs) && (card.kind === "repertoire-line" || card.confirm === "confirmed"));
const fresh = [
  ...cards
    .filter((card) => card.kind === "repertoire-line" && card.srs.box === 0)
    .sort((left, right) => right.weight - left.weight || left.ply - right.ply || left.id.localeCompare(right.id))
    .slice(0, SCHEDULES["repertoire-line"].newPerDay),
  ...cards
    .filter((card) => card.kind === "own-mistake" && card.srs.box === 0 && card.confirm !== "rejected")
    .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id))
    .slice(0, SCHEDULES["own-mistake"].newPerDay)
];
const today = [...due, ...fresh].sort(
  (left, right) =>
    left.kind.localeCompare(right.kind) || sessionPriority(right.kind, right.srs, right.weight, nowMs) - sessionPriority(left.kind, left.srs, left.weight, nowMs)
);
const moveLabel = (ply: number, san: string) => `${Math.ceil(ply / 2)}${ply % 2 ? "." : "..."}${san}`;
console.log(`\nDue today: ${today.filter((card) => card.kind === "repertoire-line").length} line moves · ${today.filter((card) => card.kind === "own-mistake").length} positions from your games`);
printTable(
  today.map((card) => ({
    kind: card.kind === "repertoire-line" ? "YOUR REPERTOIRE LINE" : "POSITION FROM YOUR GAME",
    color: card.color,
    line: card.pathSan.map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}.${san}` : san)).join(" ") || "(start)",
    move:
      card.kind === "repertoire-line"
        ? `your move ${moveLabel(card.ply, card.primary!.san)}`
        : `you played ${moveLabel(card.ply, card.sources[0].playedSan)} (−${card.sources[0].loss.toFixed(1)}) vs ${card.sources[0].opponent}`,
    games: card.sources.length,
    weight: card.weight.toFixed(2),
    state: card.srs.box ? `box ${card.srs.box}` : card.kind === "own-mistake" ? `new (${card.confirm})` : "new",
    review: card.sources[0] ? `/review/${card.sources[0].gameId}?ply=${card.sources[0].ply}` : ""
  }))
);

// The 2...Bc5 acceptance position.
const italianEpd = epdAfterMoves(["e2e4", "e7e5", "g1f3"]);
const italian = cards.find((card) => card.color === "black" && card.epd === italianEpd);
if (italian) {
  const deep = configId !== null ? getDeepEval(db, configId, italianEpd) : undefined;
  const top = deep?.lines[0];
  const accepted = top
    ? acceptableMoves(
        [...deep!.lines, ...deep!.scored].map((line) => ({ uci: line.uci, san: line.uci, loss: rootMoveLoss(top, line) })),
        entries.black.get(italianEpd) ?? null
      ).map((move) => move.uci)
    : null;
  const weights = cards.filter((card) => card.kind === "own-mistake").map((card) => card.weight).sort((left, right) => right - left);
  console.log(
    `\n1.e4 e5 2.Nf3: ${italian.kind} card, weight ${italian.weight.toFixed(2)} (top mistake weight ${weights[0]?.toFixed(2) ?? "–"}), ` +
      `${italian.sources.length} games (${[...new Set(italian.sources.map((source) => source.playedSan))].join(", ")}); ` +
      `accepted on the deep tier: ${accepted ? accepted.join(", ") : "not deep-checked yet"}.`
  );
  if (accepted) {
    check(accepted.includes("b8c6"), "1.e4 e5 2.Nf3: Nc6 is not accepted");
    check(!accepted.includes("f8c5"), "1.e4 e5 2.Nf3: Bc5 is accepted");
  }
} else {
  console.log("\n1.e4 e5 2.Nf3: no card (no analysed game of the window went wrong there, and the repertoire does not reach it).");
}
if (golden) {
  check(cards.some((card) => card.kind === "own-mistake") === (engine !== null && occurrences.length > 0), "mistake cards do not match the first errors");
}

db.close();
if (failures.length) {
  console.log(`\nFAILED (${failures.length}):`);
  for (const failure of failures.slice(0, 30)) {
    console.log(`- ${failure}`);
  }
  process.exit(1);
}
console.log("\nverify-cards: OK");

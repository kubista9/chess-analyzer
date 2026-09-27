import type { EngineLine, EngineTier, PositionEval } from "../../shared/types.js";
import type { Db } from "./connection.js";

// Engine results per (EPD, engine config, tier). A lookup for a tier accepts a row of that
// tier or a higher one (an owner-tier MultiPV 3 row answers an opponent-tier request), so a
// position seen in both roles is never served a lower-tier result.

/** Tiers from highest to lowest. */
export const TIER_ORDER: readonly EngineTier[] = ["owner", "opponent"];

function tiersAtLeast(tier: EngineTier): EngineTier[] {
  return TIER_ORDER.slice(0, TIER_ORDER.indexOf(tier) + 1);
}

interface PositionRow {
  epd: string;
  tier: string;
  cp: number | null;
  mate: number | null;
  best_uci: string | null;
  lines_json: string;
  depth: number;
  nodes: number;
  analyzed_at: number;
}

interface StoredLines {
  lines: EngineLine[];
  scored: EngineLine[];
  terminal: PositionEval["terminal"];
}

function toEval(row: PositionRow): PositionEval {
  const stored = JSON.parse(row.lines_json) as StoredLines;
  return {
    epd: row.epd,
    tier: row.tier as EngineTier,
    depth: row.depth,
    nodes: row.nodes,
    lines: stored.lines,
    scored: stored.scored,
    terminal: stored.terminal,
    bestUci: row.best_uci,
    score: { cp: row.cp, mate: row.mate }
  };
}

const SELECT_COLUMNS = "epd, tier, cp, mate, best_uci, lines_json, depth, nodes, analyzed_at";

/** The best stored eval of `epd` at `tier` or above under a config, or undefined. */
export function getPositionEval(db: Db, configId: number, epd: string, tier: EngineTier): PositionEval | undefined {
  const tiers = tiersAtLeast(tier);
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM positions
       WHERE epd = ? AND config_id = ? AND tier IN (${tiers.map(() => "?").join(", ")})`
    )
    .all(epd, configId, ...tiers) as PositionRow[];
  rows.sort((left, right) => TIER_ORDER.indexOf(left.tier as EngineTier) - TIER_ORDER.indexOf(right.tier as EngineTier));
  return rows[0] ? toEval(rows[0]) : undefined;
}

/** Inserts or replaces the eval of (epd, config, eval.tier), e.g. after new moves were scored. */
export function putPositionEval(db: Db, configId: number, evaluation: PositionEval, now = Date.now()): void {
  const stored: StoredLines = { lines: evaluation.lines, scored: evaluation.scored, terminal: evaluation.terminal };
  db.prepare(
    `INSERT INTO positions (epd, config_id, tier, cp, mate, best_uci, lines_json, depth, nodes, analyzed_at)
     VALUES (@epd, @configId, @tier, @cp, @mate, @bestUci, @linesJson, @depth, @nodes, @analyzedAt)
     ON CONFLICT (epd, config_id, tier) DO UPDATE SET
       cp = excluded.cp, mate = excluded.mate, best_uci = excluded.best_uci, lines_json = excluded.lines_json,
       depth = excluded.depth, nodes = excluded.nodes, analyzed_at = excluded.analyzed_at`
  ).run({
    epd: evaluation.epd,
    configId,
    tier: evaluation.tier,
    cp: evaluation.score.cp,
    mate: evaluation.score.mate,
    bestUci: evaluation.bestUci,
    linesJson: JSON.stringify(stored),
    depth: evaluation.depth,
    nodes: evaluation.nodes,
    analyzedAt: now
  });
}

/** Stored positions under a config, per tier. */
export function countPositions(db: Db, configId: number): Record<EngineTier, number> {
  const rows = db.prepare("SELECT tier, COUNT(*) AS n FROM positions WHERE config_id = ? GROUP BY tier").all(configId) as {
    tier: EngineTier;
    n: number;
  }[];
  const counts: Record<EngineTier, number> = { owner: 0, opponent: 0 };
  for (const row of rows) {
    counts[row.tier] = row.n;
  }
  return counts;
}

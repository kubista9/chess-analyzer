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

/**
 * Inserts or replaces the eval of (epd, config, eval.tier), e.g. after new moves were scored.
 * When the stored row has the same MultiPV lines (both writers extended the same cached
 * search, e.g. the review and a backfill in another process), the scored moves are merged,
 * so neither write drops the other's follow-ups. A different main search replaces the row.
 */
export function putPositionEval(db: Db, configId: number, evaluation: PositionEval, now = Date.now()): void {
  db.transaction(() => {
    const existing = db
      .prepare("SELECT lines_json, nodes FROM positions WHERE epd = ? AND config_id = ? AND tier = ?")
      .get(evaluation.epd, configId, evaluation.tier) as { lines_json: string; nodes: number } | undefined;
    let scored = evaluation.scored;
    let nodes = evaluation.nodes;
    if (existing) {
      const stored = JSON.parse(existing.lines_json) as StoredLines;
      if (JSON.stringify(stored.lines) === JSON.stringify(evaluation.lines)) {
        const have = new Set(scored.map((line) => line.uci));
        scored = [...scored, ...stored.scored.filter((line) => !have.has(line.uci))];
        nodes = Math.max(nodes, existing.nodes);
      }
    }
    const lines: StoredLines = { lines: evaluation.lines, scored, terminal: evaluation.terminal };
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
      linesJson: JSON.stringify(lines),
      depth: evaluation.depth,
      nodes,
      analyzedAt: now
    });
  }).immediate();
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

/**
 * The window's opening positions, one per (EPD, tier) as the owner's games reach them (the
 * mover of ply p is White when p is odd), and how many have a stored eval at that tier or
 * above. "Cached" means a row exists; a move first played after the row was written still
 * needs its follow-up, which the work queue takes care of.
 */
export function windowPositionCoverage(
  db: Db,
  query: { username: string; configId: number; windowStart: number; openingPlies: number }
): Record<EngineTier, { total: number; cached: number }> {
  const rows = db
    .prepare(
      `WITH wp AS (
         SELECT DISTINCT p.epd_before AS epd,
           CASE WHEN (p.ply % 2 = 1) = (g.color = 'white') THEN 'owner' ELSE 'opponent' END AS tier
         FROM game_plies p JOIN games g ON g.id = p.game_id
         WHERE g.username = @username AND g.end_time >= @windowStart AND p.ply <= @openingPlies
       )
       SELECT tier, COUNT(*) AS total,
         SUM(EXISTS (
           SELECT 1 FROM positions x
           WHERE x.epd = wp.epd AND x.config_id = @configId AND (x.tier = wp.tier OR x.tier = 'owner')
         )) AS cached
       FROM wp GROUP BY tier`
    )
    .all(query) as { tier: EngineTier; total: number; cached: number }[];
  const coverage: Record<EngineTier, { total: number; cached: number }> = {
    owner: { total: 0, cached: 0 },
    opponent: { total: 0, cached: 0 }
  };
  for (const row of rows) {
    coverage[row.tier] = { total: row.total, cached: row.cached };
  }
  return coverage;
}

/** Mean nodes per stored position (main search plus follow-ups) per tier, with the row counts. */
export function averageNodes(db: Db, configId: number): Record<EngineTier, { n: number; mean: number }> {
  const rows = db
    .prepare("SELECT tier, COUNT(*) AS n, AVG(nodes) AS mean FROM positions WHERE config_id = ? AND nodes > 0 GROUP BY tier")
    .all(configId) as { tier: EngineTier; n: number; mean: number }[];
  const result: Record<EngineTier, { n: number; mean: number }> = { owner: { n: 0, mean: 0 }, opponent: { n: 0, mean: 0 } };
  for (const row of rows) {
    result[row.tier] = { n: row.n, mean: row.mean };
  }
  return result;
}

/** A cheap change stamp of a config's positions: rows are only ever inserted or upgraded (analyzed_at moves). */
export function positionsStamp(db: Db, configId: number): { count: number; lastAt: number } {
  const row = db.prepare("SELECT COUNT(*) AS n, MAX(analyzed_at) AS m FROM positions WHERE config_id = ?").get(configId) as {
    n: number;
    m: number | null;
  };
  return { count: row.n, lastAt: row.m ?? 0 };
}

/** Every eval of a config written at or after `sinceMs` (ms since the epoch), for incremental in-memory indexes. */
export function listPositionEvals(db: Db, configId: number, sinceMs = 0): PositionEval[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM positions WHERE config_id = ? AND analyzed_at >= ?`)
    .all(configId, sinceMs) as PositionRow[];
  return rows.map(toEval);
}

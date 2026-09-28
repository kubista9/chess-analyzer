import type { EngineTier } from "../../shared/types.js";

// The engine search protocol. It is part of the engine config key (engine_configs.protocol_json),
// so any change here creates a new config and re-queues the window's games; old results are
// kept under their own config and never silently reused.
//
// Fixed depth, not movetime or nodes: a depth result does not depend on machine load, and the
// played move can be scored at exactly the depth of the best line. Budget, measured on the
// owner's M1 (single-thread Stockfish 18, Hash 64, on battery; details in docs/phases/P4a.md):
// - owner to move, MultiPV 3 at depth 15: 349k nodes warm (in game order) / 392k cold, per
//   position (0.57-0.64 s); depth 16 would be 568k, depth 14 262k;
// - played move outside the top 3 (40-47% of positions): `go depth 15 searchmoves <m>`,
//   89-104k nodes;
// - opponent to move, MultiPV 1 at depth 14: 42k warm / 86k cold.
// For the 6-month window (8,246 owner + 7,976 opponent positions at 20 plies) that is about
// 3.5-4.3G nodes: 52-64 min at the measured 1.12M nps of 3 workers on battery, roughly half
// that on mains power. Depth 16 for the owner alone would be about 80 min.
export const ENGINE_PROTOCOL = {
  version: 1,
  threads: 1,
  hashMb: 64,
  tiers: {
    owner: { multipv: 3, depth: 15 },
    opponent: { multipv: 1, depth: 14 }
  },
  // Moves played from a position but outside its MultiPV lines are scored with
  // `go depth <depth of the lines> searchmoves <moves>` at MultiPV = |moves|, on the warm hash.
  searchmoves: "depth-matched",
  // A guard against pathological positions; at depth 15 no sampled position needed 1M nodes.
  nodeCap: 3_000_000,
  pvMaxMoves: 10
} as const;

export type EngineProtocol = typeof ENGINE_PROTOCOL;

export function tierSpec(tier: EngineTier, protocol: EngineProtocol = ENGINE_PROTOCOL): { multipv: number; depth: number } {
  return protocol.tiers[tier];
}

/** Watchdog per search: generous, since depth and the node cap already bound the work. */
export function searchTimeoutMs(protocol: EngineProtocol = ENGINE_PROTOCOL): number {
  // 5 s plus the node cap at a pessimistic 50k nodes per second.
  return 5_000 + Math.ceil(protocol.nodeCap / 50);
}

/** Canonical JSON: object keys sorted at every level, so equal protocols give equal strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

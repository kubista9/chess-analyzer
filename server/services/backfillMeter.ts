import type { EngineTier } from "../../shared/types.js";

// Throughput and ETA for the backfill. nps is pool-wide (all workers together) over the last
// WINDOW searches; the cost of the remaining positions is estimated per tier from the mean
// nodes of this run's searches, or from a prior until the run has its own numbers.

export const METER_WINDOW = 200;

/** Mean nodes per position (main search plus follow-ups) before a run has its own numbers. */
export const PRIOR_NODES: Record<EngineTier, number> = {
  // P4a measurements at depth 15 / 14 (docs/phases/P4a.md): owner MultiPV 3 about 350-390k
  // plus a ~95k follow-up for about half the positions; opponent MultiPV 1 about 40-90k plus
  // a ~78k follow-up for about three quarters of them.
  owner: 420_000,
  opponent: 120_000
};

/** Pool-wide nps before any measurement: 3 workers on the owner's M1 on battery (P4a). */
export const DEFAULT_NPS = 1_120_000;

interface Sample {
  at: number;
  nodes: number;
}

export class ThroughputMeter {
  private readonly samples: Sample[] = [];
  private readonly perTier: Record<EngineTier, { n: number; nodes: number }> = {
    owner: { n: 0, nodes: 0 },
    opponent: { n: 0, nodes: 0 }
  };

  constructor(
    private readonly prior: { nodes: Record<EngineTier, number>; nps: number } = { nodes: PRIOR_NODES, nps: DEFAULT_NPS },
    private readonly window = METER_WINDOW
  ) {}

  /** A finished search: when it finished and the nodes it took. */
  record(tier: EngineTier, nodes: number, at: number): void {
    this.samples.push({ at, nodes });
    if (this.samples.length > this.window) {
      this.samples.shift();
    }
    this.perTier[tier].n += 1;
    this.perTier[tier].nodes += nodes;
  }

  /** Pool-wide nodes per second over the window, or null with fewer than 5 searches. */
  nps(): number | null {
    if (this.samples.length < 5) {
      return null;
    }
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const spanMs = last.at - first.at;
    if (spanMs <= 0) {
      return null;
    }
    // The first sample's nodes were searched before the window opened.
    const nodes = this.samples.slice(1).reduce((sum, sample) => sum + sample.nodes, 0);
    return (nodes / spanMs) * 1000;
  }

  /** Mean nodes per search of a tier in this run (after 5 searches), else the prior. */
  meanNodes(tier: EngineTier): number {
    const stats = this.perTier[tier];
    return stats.n >= 5 ? stats.nodes / stats.n : this.prior.nodes[tier];
  }

  /** Seconds left for the remaining searches per tier. */
  etaSec(remaining: Record<EngineTier, number>): number {
    const nodes = remaining.owner * this.meanNodes("owner") + remaining.opponent * this.meanNodes("opponent");
    return nodes / (this.nps() ?? this.prior.nps);
  }
}

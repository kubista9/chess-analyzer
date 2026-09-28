import { describe, expect, it } from "vitest";
import { DEFAULT_NPS, PRIOR_NODES, ThroughputMeter } from "./backfillMeter.js";

describe("ThroughputMeter", () => {
  it("uses the priors until it has measured enough searches", () => {
    const meter = new ThroughputMeter();
    expect(meter.nps()).toBeNull();
    expect(meter.etaSec({ owner: 10, opponent: 10 })).toBeCloseTo((10 * PRIOR_NODES.owner + 10 * PRIOR_NODES.opponent) / DEFAULT_NPS, 6);
  });

  it("measures pool-wide nps over the window and the mean cost per tier", () => {
    const meter = new ThroughputMeter({ nodes: PRIOR_NODES, nps: DEFAULT_NPS }, 6);
    // 1M nodes every 0.5 s = 2M nps, whatever the window slides over.
    for (let index = 0; index < 10; index += 1) {
      meter.record("owner", 1_000_000, index * 500);
    }
    expect(meter.nps()).toBeCloseTo(2_000_000, 0);
    expect(meter.meanNodes("owner")).toBe(1_000_000);
    // The opponent tier has no numbers of its own yet.
    expect(meter.meanNodes("opponent")).toBe(PRIOR_NODES.opponent);
    expect(meter.etaSec({ owner: 4, opponent: 0 })).toBeCloseTo(2, 6);
  });
});

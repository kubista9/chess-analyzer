import { execFileSync } from "node:child_process";
import type { PowerState } from "../../shared/types.js";

// Power state on macOS, from `pmset`. The backfill saturates ENGINE_WORKERS cores for up to
// an hour, so it asks before running on battery (and says so in Low Power Mode, which roughly
// halves the engine's speed).

/** Parses `pmset -g batt`: "Now drawing from 'Battery Power'" / "'AC Power'", and the charge. */
export function parsePmsetBatt(output: string): Pick<PowerState, "onBattery" | "percent"> | null {
  const source = /Now drawing from '([^']+)'/.exec(output)?.[1];
  if (!source) {
    return null;
  }
  const percent = /(\d{1,3})%/.exec(output)?.[1];
  return { onBattery: /battery/i.test(source), percent: percent === undefined ? null : Number(percent) };
}

/** Parses the `lowpowermode` line of `pmset -g`, or null when it is absent. */
export function parseLowPowerMode(output: string): boolean | null {
  const value = /^\s*lowpowermode\s+(\d)/m.exec(output)?.[1];
  return value === undefined ? null : value === "1";
}

function pmset(args: string[]): string | null {
  try {
    return execFileSync("pmset", args, { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** The machine's power state, or null where pmset is not available (not macOS). */
export function readPowerState(): PowerState | null {
  if (process.platform !== "darwin") {
    return null;
  }
  const batt = pmset(["-g", "batt"]);
  const parsed = batt ? parsePmsetBatt(batt) : null;
  if (!parsed) {
    return null;
  }
  const all = pmset(["-g"]);
  return { ...parsed, lowPowerMode: all ? parseLowPowerMode(all) : null };
}

/** "on battery (63%), Low Power Mode on", for warnings. */
export function describePower(power: PowerState): string {
  const parts = [power.onBattery ? `on battery${power.percent === null ? "" : ` (${power.percent}%)`}` : "on mains power"];
  if (power.lowPowerMode) {
    parts.push("Low Power Mode on");
  }
  return parts.join(", ");
}

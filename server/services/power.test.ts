import { describe, expect, it } from "vitest";
import { describePower, parseLowPowerMode, parsePmsetBatt } from "./power.js";

describe("pmset parsing", () => {
  it("reads the power source and the charge", () => {
    const battery = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=38010979)\t63%; discharging; 11:25 remaining present: true\n";
    expect(parsePmsetBatt(battery)).toEqual({ onBattery: true, percent: 63 });
    const mains = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=38010979)\t100%; charged; 0:00 remaining present: true\n";
    expect(parsePmsetBatt(mains)).toEqual({ onBattery: false, percent: 100 });
    expect(parsePmsetBatt("Now drawing from 'AC Power'\n")).toEqual({ onBattery: false, percent: null });
    expect(parsePmsetBatt("garbage")).toBeNull();
  });

  it("reads Low Power Mode from pmset -g", () => {
    expect(parseLowPowerMode("System-wide power settings:\nCurrently in use:\n standby              1\n lowpowermode         1\n")).toBe(true);
    expect(parseLowPowerMode(" lowpowermode         0\n")).toBe(false);
    expect(parseLowPowerMode(" standby 1\n")).toBeNull();
  });

  it("describes the state for warnings", () => {
    expect(describePower({ onBattery: true, percent: 63, lowPowerMode: true })).toBe("on battery (63%), Low Power Mode on");
    expect(describePower({ onBattery: false, percent: 100, lowPowerMode: false })).toBe("on mains power");
  });
});

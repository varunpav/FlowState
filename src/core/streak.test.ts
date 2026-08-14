import { describe, expect, it } from "vitest";
import { currentStreak, dayKeyOf, updateLog } from "./streak";

describe("dayKeyOf", () => {
  it("is independent of the host machine's timezone (pure UTC arithmetic)", () => {
    // 2026-01-15T23:30:00Z, US Eastern standard time offset (UTC-5 => -300)
    const nowMs = Date.UTC(2026, 0, 15, 23, 30, 0);
    expect(dayKeyOf(nowMs, -300)).toBe("2026-01-15"); // 18:30 local, still the 15th
  });

  it("crosses midnight correctly at the local day boundary", () => {
    // 2026-01-16T05:00:00Z is 00:00 local at UTC-5 exactly
    const justBefore = Date.UTC(2026, 0, 16, 4, 59, 59);
    const atMidnight = Date.UTC(2026, 0, 16, 5, 0, 0);
    expect(dayKeyOf(justBefore, -300)).toBe("2026-01-15");
    expect(dayKeyOf(atMidnight, -300)).toBe("2026-01-16");
  });

  it("respects the passed-in offset rather than any ambient DST rules", () => {
    // Same UTC instant, pre- and post-DST-shift offsets for US Eastern (EST -300, EDT -240)
    const instant = Date.UTC(2026, 2, 8, 6, 30, 0); // 2026-03-08 06:30 UTC
    expect(dayKeyOf(instant, -300)).toBe("2026-03-08"); // 01:30 EST -> still the 8th
    expect(dayKeyOf(instant, -240)).toBe("2026-03-08"); // 02:30 EDT -> still the 8th
  });

  it("rolls over month and year boundaries", () => {
    const endOfFeb = Date.UTC(2027, 0, 1, 4, 30, 0); // just before UTC-5 midnight on Jan 1
    expect(dayKeyOf(endOfFeb, -300)).toBe("2026-12-31");
    const newYear = Date.UTC(2027, 0, 1, 5, 0, 0);
    expect(dayKeyOf(newYear, -300)).toBe("2027-01-01");
  });
});

describe("updateLog", () => {
  it("increments the count for a day key without mutating the input", () => {
    const log = { "2026-01-15": 1 };
    const next = updateLog(log, "2026-01-15");
    expect(next).toEqual({ "2026-01-15": 2 });
    expect(log).toEqual({ "2026-01-15": 1 });
  });

  it("starts a new day key at 1", () => {
    expect(updateLog({}, "2026-01-15")).toEqual({ "2026-01-15": 1 });
  });
});

describe("currentStreak", () => {
  it("counts consecutive confirmed days ending today", () => {
    const log = { "2026-01-13": 1, "2026-01-14": 2, "2026-01-15": 1 };
    expect(currentStreak(log, "2026-01-15")).toBe(3);
  });

  it("stops at the first missing day going backward", () => {
    const log = { "2026-01-11": 1, "2026-01-14": 1, "2026-01-15": 1 };
    expect(currentStreak(log, "2026-01-15")).toBe(2);
  });

  it("is zero when today has no confirmation yet", () => {
    const log = { "2026-01-14": 1 };
    expect(currentStreak(log, "2026-01-15")).toBe(0);
  });

  it("handles a streak that crosses a month/year boundary", () => {
    const log = { "2026-12-31": 1, "2027-01-01": 1, "2027-01-02": 1 };
    expect(currentStreak(log, "2027-01-02")).toBe(3);
  });
});

import { describe, expect, it } from "vitest";
import {
  addDays,
  clearDay,
  dayKeyOf,
  entryOn,
  goalStreak,
  lastNDays,
  logWater,
  monthToDate,
  normalizeLog,
  rangeStats,
  calendarYearHeatmap,
  removeWater,
  yearToDate,
  type DailyLog,
} from "./waterLog";

describe("dayKeyOf", () => {
  it("is independent of the host machine's timezone (pure UTC arithmetic)", () => {
    const nowMs = Date.UTC(2026, 0, 15, 23, 30, 0);
    expect(dayKeyOf(nowMs, -300)).toBe("2026-01-15");
  });

  it("crosses midnight correctly at the local day boundary", () => {
    const justBefore = Date.UTC(2026, 0, 16, 4, 59, 59);
    const atMidnight = Date.UTC(2026, 0, 16, 5, 0, 0);
    expect(dayKeyOf(justBefore, -300)).toBe("2026-01-15");
    expect(dayKeyOf(atMidnight, -300)).toBe("2026-01-16");
  });

  it("respects the passed-in offset rather than any ambient DST rules", () => {
    const instant = Date.UTC(2026, 2, 8, 6, 30, 0);
    expect(dayKeyOf(instant, -300)).toBe("2026-03-08");
    expect(dayKeyOf(instant, -240)).toBe("2026-03-08");
  });

  it("rolls over month and year boundaries", () => {
    const endOfFeb = Date.UTC(2027, 0, 1, 4, 30, 0);
    expect(dayKeyOf(endOfFeb, -300)).toBe("2026-12-31");
    const newYear = Date.UTC(2027, 0, 1, 5, 0, 0);
    expect(dayKeyOf(newYear, -300)).toBe("2027-01-01");
  });
});

describe("addDays", () => {
  it("adds and subtracts days within a month", () => {
    expect(addDays("2026-01-15", 1)).toBe("2026-01-16");
    expect(addDays("2026-01-15", -1)).toBe("2026-01-14");
  });

  it("crosses month and year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("logWater / entryOn", () => {
  it("defaults to a zero entry for an unlogged day", () => {
    expect(entryOn({}, "2026-01-15")).toEqual({ oz: 0, count: 0 });
  });

  it("accumulates oz and count without mutating the input", () => {
    const log: DailyLog = { "2026-01-15": { oz: 24, count: 1 } };
    const next = logWater(log, "2026-01-15", 16);
    expect(next["2026-01-15"]).toEqual({ oz: 40, count: 2 });
    expect(log["2026-01-15"]).toEqual({ oz: 24, count: 1 });
  });

  it("starts a fresh day at the logged amount", () => {
    expect(logWater({}, "2026-01-15", 24)["2026-01-15"]).toEqual({ oz: 24, count: 1 });
  });
});

describe("removeWater", () => {
  it("subtracts oz and decrements count, without mutating the input", () => {
    const log: DailyLog = { "2026-01-15": { oz: 72, count: 3 } };
    const next = removeWater(log, "2026-01-15", 24);
    expect(next["2026-01-15"]).toEqual({ oz: 48, count: 2 });
    expect(log["2026-01-15"]).toEqual({ oz: 72, count: 3 });
  });

  it("floors oz and count at 0 rather than going negative", () => {
    const log: DailyLog = { "2026-01-15": { oz: 10, count: 0 } };
    expect(removeWater(log, "2026-01-15", 24)).toEqual({ "2026-01-15": { oz: 0, count: 0 } });
  });

  it("is a no-op-shaped zero result on an unlogged day", () => {
    expect(removeWater({}, "2026-01-15", 10)).toEqual({ "2026-01-15": { oz: 0, count: 0 } });
  });
});

describe("clearDay", () => {
  it("zeroes out a day's oz and count without mutating the input", () => {
    const log: DailyLog = { "2026-01-15": { oz: 96, count: 4 } };
    const next = clearDay(log, "2026-01-15");
    expect(next["2026-01-15"]).toEqual({ oz: 0, count: 0 });
    expect(log["2026-01-15"]).toEqual({ oz: 96, count: 4 });
  });

  it("leaves other days untouched", () => {
    const log: DailyLog = { "2026-01-14": { oz: 50, count: 2 }, "2026-01-15": { oz: 96, count: 4 } };
    const next = clearDay(log, "2026-01-15");
    expect(next["2026-01-14"]).toEqual({ oz: 50, count: 2 });
  });
});

describe("lastNDays", () => {
  it("returns n entries oldest-to-newest, ending at today", () => {
    const log: DailyLog = { "2026-01-15": { oz: 100, count: 3 } };
    const days = lastNDays(log, "2026-01-15", 3);
    expect(days.map((d) => d.dayKey)).toEqual(["2026-01-13", "2026-01-14", "2026-01-15"]);
    expect(days[2]?.entry).toEqual({ oz: 100, count: 3 });
    expect(days[0]?.entry).toEqual({ oz: 0, count: 0 });
  });
});

describe("rangeStats", () => {
  it("reports all-zero stats when nothing was ever logged", () => {
    expect(rangeStats({}, "2026-01-01", "2026-01-31")).toEqual({
      avgOzPerDay: 0,
      daysAtGoal: 0,
      daysCounted: 0,
    });
  });

  it("counts only from the first logged day, not the full range (avoids the ~8oz/day bug)", () => {
    const log: DailyLog = { "2026-01-01": { oz: 128, count: 1 } };
    // Range spans 3 days but only day 1 has data — daysCounted should be 3
    // (first logged day through end), diluting the average, not reporting
    // a naive 128 oz/day as if only counting days-with-data.
    const stats = rangeStats(log, "2026-01-01", "2026-01-03", 128);
    expect(stats.daysCounted).toBe(3);
    expect(stats.avgOzPerDay).toBeCloseTo(128 / 3);
    expect(stats.daysAtGoal).toBe(1);
  });

  it("reports a clean 128 oz/day average when the range is exactly the one logged day", () => {
    const log: DailyLog = { "2026-01-01": { oz: 128, count: 1 } };
    const stats = rangeStats(log, "2026-01-01", "2026-01-01", 128);
    expect(stats).toEqual({ avgOzPerDay: 128, daysAtGoal: 1, daysCounted: 1 });
  });
});

describe("monthToDate / yearToDate", () => {
  it("scopes monthToDate to the 1st of the month through today", () => {
    const log: DailyLog = { "2026-03-01": { oz: 128, count: 1 }, "2026-03-15": { oz: 128, count: 1 } };
    const stats = monthToDate(log, "2026-03-15", 128);
    expect(stats.daysCounted).toBe(15);
    expect(stats.daysAtGoal).toBe(2);
  });

  it("scopes yearToDate to January 1st through today", () => {
    const log: DailyLog = { "2026-01-01": { oz: 128, count: 1 } };
    const stats = yearToDate(log, "2026-01-10", 128);
    expect(stats.daysCounted).toBe(10);
  });
});

describe("goalStreak", () => {
  it("counts from today backward when today already hit goal", () => {
    const log: DailyLog = {
      "2026-01-13": { oz: 128, count: 1 },
      "2026-01-14": { oz: 128, count: 1 },
      "2026-01-15": { oz: 128, count: 1 },
    };
    expect(goalStreak(log, "2026-01-15", 128)).toBe(3);
  });

  it("counts from yesterday when today has not hit goal yet (not zero)", () => {
    const log: DailyLog = {
      "2026-01-14": { oz: 128, count: 1 },
      "2026-01-15": { oz: 40, count: 1 },
    };
    expect(goalStreak(log, "2026-01-15", 128)).toBe(1);
  });

  it("stops at the first day below goal going backward", () => {
    const log: DailyLog = {
      "2026-01-11": { oz: 128, count: 1 },
      "2026-01-14": { oz: 128, count: 1 },
      "2026-01-15": { oz: 128, count: 1 },
    };
    expect(goalStreak(log, "2026-01-15", 128)).toBe(2);
  });

  it("crosses a year boundary", () => {
    const log: DailyLog = {
      "2026-12-31": { oz: 128, count: 1 },
      "2027-01-01": { oz: 128, count: 1 },
      "2027-01-02": { oz: 128, count: 1 },
    };
    expect(goalStreak(log, "2027-01-02", 128)).toBe(3);
  });
});

describe("normalizeLog", () => {
  it("returns an empty log for non-object input", () => {
    expect(normalizeLog(null)).toEqual({});
    expect(normalizeLog("nope")).toEqual({});
    expect(normalizeLog(42)).toEqual({});
  });

  it("converts a v1 plain-number count without fabricating ounces", () => {
    expect(normalizeLog({ "2026-01-15": 3 })).toEqual({ "2026-01-15": { oz: 0, count: 3 } });
  });

  it("passes through well-formed v2 entries", () => {
    expect(normalizeLog({ "2026-01-15": { oz: 64, count: 2 } })).toEqual({
      "2026-01-15": { oz: 64, count: 2 },
    });
  });

  it("drops malformed day keys and malformed entries", () => {
    expect(
      normalizeLog({
        "not-a-date": { oz: 64, count: 2 },
        "2026-01-15": { oz: -5, count: 2 },
        "2026-01-16": "garbage",
      }),
    ).toEqual({
      "2026-01-15": { oz: 0, count: 2 },
    });
  });
});

describe("calendarYearHeatmap", () => {
  // A future todayKey so the whole calendar year (2025) is in the past —
  // isolates the "future days are null" behavior to its own dedicated test.
  const farFutureToday = "2030-01-01";

  it("every week has exactly 7 slots, forming a rectangular grid", () => {
    const weeks = calendarYearHeatmap({}, 2025, farFutureToday);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
  });

  it("covers every day of the year, Jan 1 through Dec 31", () => {
    const weeks = calendarYearHeatmap({}, 2025, farFutureToday);
    const flat = weeks.flat().filter((c): c is NonNullable<typeof c> => c !== null);
    expect(flat).toHaveLength(365); // 2025 is not a leap year
    expect(flat[0]?.dayKey).toBe("2025-01-01");
    expect(flat[flat.length - 1]?.dayKey).toBe("2025-12-31");
  });

  it("includes the extra day for a leap year", () => {
    const weeks = calendarYearHeatmap({}, 2028, farFutureToday);
    const flat = weeks.flat().filter((c): c is NonNullable<typeof c> => c !== null);
    expect(flat).toHaveLength(366);
  });

  it("pads only the first and last week with nulls, never a middle week", () => {
    const weeks = calendarYearHeatmap({}, 2025, farFutureToday);
    for (const week of weeks.slice(1, -1)) {
      expect(week.every((c) => c !== null)).toBe(true);
    }
  });

  it("treats days after todayKey as null — not yet happened, not 'tracked but empty'", () => {
    const todayKey = "2026-06-15";
    const weeks = calendarYearHeatmap({}, 2026, todayKey);
    const flat = weeks.flat();
    const juneSixteenth = flat.find((c) => c?.dayKey === "2026-06-16");
    expect(juneSixteenth).toBeUndefined();
    const juneFifteenth = flat.find((c) => c?.dayKey === todayKey);
    expect(juneFifteenth).toBeDefined();
  });

  it("buckets oz into quarters of the goal, an empty day at level 0", () => {
    const todayKey = "2026-01-15";
    const log: DailyLog = {
      [todayKey]: { oz: 0, count: 0 },
      "2026-01-14": { oz: 20, count: 1 },
      "2026-01-13": { oz: 40, count: 1 },
      "2026-01-12": { oz: 80, count: 1 },
      "2026-01-11": { oz: 100, count: 1 },
      "2026-01-10": { oz: 150, count: 1 },
    };
    const flat = calendarYearHeatmap(log, 2026, todayKey, 100)
      .flat()
      .filter((c): c is NonNullable<typeof c> => c !== null);
    const byKey = new Map(flat.map((c) => [c.dayKey, c.level]));
    expect(byKey.get(todayKey)).toBe(0);
    expect(byKey.get("2026-01-14")).toBe(1);
    expect(byKey.get("2026-01-13")).toBe(2);
    expect(byKey.get("2026-01-12")).toBe(3);
    expect(byKey.get("2026-01-11")).toBe(4);
    expect(byKey.get("2026-01-10")).toBe(4);
  });

  it("treats a zero/negative goal as any logged water being the deepest shade", () => {
    const todayKey = "2026-01-15";
    const log: DailyLog = { [todayKey]: { oz: 5, count: 1 } };
    const flat = calendarYearHeatmap(log, 2026, todayKey, 0)
      .flat()
      .filter((c): c is NonNullable<typeof c> => c !== null);
    expect(flat.find((c) => c.dayKey === todayKey)?.level).toBe(4);
  });
});

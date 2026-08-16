import { describe, expect, it } from "vitest";
import { formatClockTime, formatCountdown, relativeDayLabel } from "./format";

describe("formatClockTime", () => {
  it("formats an afternoon time with AM/PM", () => {
    const ms = Date.UTC(2026, 0, 15, 19, 42);
    expect(formatClockTime(ms, "UTC")).toBe("7:42 PM");
  });

  it("formats midnight as 12 AM, not 0", () => {
    const ms = Date.UTC(2026, 0, 15, 0, 5);
    expect(formatClockTime(ms, "UTC")).toBe("12:05 AM");
  });

  it("formats noon as 12 PM", () => {
    const ms = Date.UTC(2026, 0, 15, 12, 0);
    expect(formatClockTime(ms, "UTC")).toBe("12:00 PM");
  });
});

describe("formatCountdown", () => {
  it("formats hours:minutes:seconds when over an hour remains", () => {
    const ms = 1 * 60 * 60 * 1000 + 47 * 60 * 1000 + 12 * 1000;
    expect(formatCountdown(ms)).toBe("1:47:12");
  });

  it("formats minutes:seconds under an hour, without an hour segment", () => {
    expect(formatCountdown(90 * 1000)).toBe("1:30");
  });

  it("floors negative/past-due durations to 0:00", () => {
    expect(formatCountdown(-5000)).toBe("0:00");
  });
});

describe("relativeDayLabel", () => {
  it("labels the current day as Today", () => {
    expect(relativeDayLabel("2026-01-15", "2026-01-15")).toBe("Today");
  });

  it("labels the day before as Yesterday", () => {
    expect(relativeDayLabel("2026-01-14", "2026-01-15")).toBe("Yesterday");
  });

  it("labels a day before yesterday as weekday + month + day, in UTC", () => {
    // 2026-01-01 is a Thursday (2025-01-01 was a Wednesday; 2025 has 365 days).
    expect(relativeDayLabel("2026-01-01", "2026-01-15")).toBe("Thu Jan 1");
  });

  it("crosses a month boundary correctly for Yesterday", () => {
    expect(relativeDayLabel("2026-01-31", "2026-02-01")).toBe("Yesterday");
  });
});

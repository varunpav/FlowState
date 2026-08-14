import { describe, expect, it } from "vitest";
import { computeNextDeadline, formatCountdown, remainingMs } from "./schedule";

describe("computeNextDeadline", () => {
  it("adds the interval to now", () => {
    expect(computeNextDeadline({ intervalMs: 2 * 60 * 60 * 1000 }, 1_000)).toBe(
      1_000 + 2 * 60 * 60 * 1000,
    );
  });
});

describe("remainingMs", () => {
  it("returns the gap to the deadline", () => {
    expect(remainingMs(10_000, 4_000)).toBe(6_000);
  });

  it("clamps to zero once the deadline has passed (suspend gap)", () => {
    // e.g. the machine slept through the deadline by 4 hours
    expect(remainingMs(1_000, 1_000 + 4 * 60 * 60 * 1000)).toBe(0);
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

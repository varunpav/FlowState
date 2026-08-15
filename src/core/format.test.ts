import { describe, expect, it } from "vitest";
import { formatCountdown } from "./format";

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

import { describe, expect, it } from "vitest";
import { INACTIVITY_THRESHOLD_SECONDS, isIdle } from "./idlePolicy";

describe("isIdle", () => {
  it("defaults to a 5 second threshold", () => {
    expect(INACTIVITY_THRESHOLD_SECONDS).toBe(5);
  });

  it("is not idle for brief pauses under the threshold", () => {
    expect(isIdle(0)).toBe(false);
    expect(isIdle(4)).toBe(false);
  });

  it("is idle at and beyond the threshold", () => {
    expect(isIdle(5)).toBe(true);
    expect(isIdle(30)).toBe(true);
  });

  it("accepts a custom threshold", () => {
    expect(isIdle(3, 10)).toBe(false);
    expect(isIdle(10, 10)).toBe(true);
  });
});

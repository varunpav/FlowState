import { describe, expect, it } from "vitest";
import { decideOnDue, IDLE_DISPLAY_THRESHOLD_SECONDS, isIdle, shouldResumeDeferred } from "./idlePolicy";

const config = { deferThresholdSeconds: 15 * 60, resumeThresholdSeconds: 60 };

describe("decideOnDue", () => {
  it("fires when the user is actively present", () => {
    expect(decideOnDue(0, config)).toBe("fire");
  });

  it("fires at exactly the defer threshold (boundary is inclusive of firing)", () => {
    expect(decideOnDue(config.deferThresholdSeconds, config)).toBe("fire");
  });

  it("defers once idle exceeds the threshold", () => {
    expect(decideOnDue(config.deferThresholdSeconds + 1, config)).toBe("defer");
  });
});

describe("shouldResumeDeferred", () => {
  it("does not resume while still idle", () => {
    expect(shouldResumeDeferred(120, config)).toBe(false);
  });

  it("resumes once idle drops below the resume threshold", () => {
    expect(shouldResumeDeferred(59, config)).toBe(true);
  });

  it("does not resume at exactly the resume threshold", () => {
    expect(shouldResumeDeferred(60, config)).toBe(false);
  });
});

describe("isIdle", () => {
  it("defaults to a 5 second debounce", () => {
    expect(IDLE_DISPLAY_THRESHOLD_SECONDS).toBe(5);
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

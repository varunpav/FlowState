import { describe, expect, it } from "vitest";
import { decideOnDue, shouldResumeDeferred } from "./idlePolicy";

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

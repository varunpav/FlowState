import { describe, expect, it } from "vitest";
import { isStaleTick, MAX_TICK_AGE_MS } from "./tickPolicy";

describe("isStaleTick", () => {
  it("defaults to a 5 second staleness threshold", () => {
    expect(MAX_TICK_AGE_MS).toBe(5_000);
  });

  it("is not stale for a fresh or nearly-fresh tick", () => {
    expect(isStaleTick(1_000, 1_000)).toBe(false);
    expect(isStaleTick(1_000, 1_000 + MAX_TICK_AGE_MS)).toBe(false); // exactly at the boundary
  });

  it("is stale once the gap exceeds the threshold", () => {
    expect(isStaleTick(1_000, 1_000 + MAX_TICK_AGE_MS + 1)).toBe(true);
  });

  it("accepts a custom threshold", () => {
    expect(isStaleTick(1_000, 1_500, 1_000)).toBe(false);
    expect(isStaleTick(1_000, 2_001, 1_000)).toBe(true);
  });

  it("a tick that appears to be from the future (clock skew) is not stale", () => {
    expect(isStaleTick(5_000, 1_000)).toBe(false);
  });
});

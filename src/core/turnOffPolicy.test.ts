import { describe, expect, it } from "vitest";
import { shouldOfferTurnOff } from "./turnOffPolicy";

describe("shouldOfferTurnOff", () => {
  it("hides Turn off for hydration until it has been snoozed at least once", () => {
    expect(shouldOfferTurnOff("hydration", 0)).toBe(false);
    expect(shouldOfferTurnOff("hydration", 1)).toBe(true);
    expect(shouldOfferTurnOff("hydration", 3)).toBe(true);
  });

  it("offers Turn off immediately for every other kind", () => {
    expect(shouldOfferTurnOff("pomodoro", 0)).toBe(true);
    expect(shouldOfferTurnOff("eyeBreak", 0)).toBe(true);
    expect(shouldOfferTurnOff("standUp", 0)).toBe(true);
  });
});

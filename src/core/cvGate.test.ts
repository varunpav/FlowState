import { describe, expect, it } from "vitest";
import { cvPrompt, waterEntryUnlocked, type CvStatus } from "./cvGate";

const ALL_STATUSES: CvStatus[] = ["off", "starting", "watching", "verified", "failed"];

describe("waterEntryUnlocked", () => {
  it("unlocks when CV is off, verified, or failed", () => {
    expect(waterEntryUnlocked("off")).toBe(true);
    expect(waterEntryUnlocked("verified")).toBe(true);
    expect(waterEntryUnlocked("failed")).toBe(true);
  });

  it("stays locked while starting or watching — that's the whole point of the gate", () => {
    expect(waterEntryUnlocked("starting")).toBe(false);
    expect(waterEntryUnlocked("watching")).toBe(false);
  });

  it("a broken camera (failed) never traps the user out of logging water", () => {
    // Restated explicitly because it's the one behavior the whole feature
    // must never regress on: unlocking on "failed", not just "verified".
    expect(waterEntryUnlocked("failed")).toBe(true);
  });
});

describe("cvPrompt", () => {
  it("has a distinct, non-empty message for every status except off", () => {
    const nonOff = ALL_STATUSES.filter((s) => s !== "off");
    const messages = nonOff.map(cvPrompt);
    expect(messages.every((m) => m.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(messages.length); // all distinct
  });

  it("is empty when CV is off — no prompt to show", () => {
    expect(cvPrompt("off")).toBe("");
  });
});

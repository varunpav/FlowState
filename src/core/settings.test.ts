import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseSettings } from "./settings";

describe("parseSettings", () => {
  it("accepts the default settings", () => {
    const result = parseSettings(DEFAULT_SETTINGS);
    expect(result).toEqual({ ok: true, value: DEFAULT_SETTINGS });
  });

  it.each([
    ["null", null],
    ["a string", "not an object"],
    ["an array", [1, 2, 3]],
    ["missing every field", {}],
    [
      "wrong type for intervalMs",
      { ...DEFAULT_SETTINGS, intervalMs: "2 hours" },
    ],
    ["intervalMs below the 60s floor", { ...DEFAULT_SETTINGS, intervalMs: 500 }],
    ["negative maxSnoozes", { ...DEFAULT_SETTINGS, maxSnoozes: -1 }],
    ["non-integer maxSnoozes", { ...DEFAULT_SETTINGS, maxSnoozes: 1.5 }],
    ["volume above 1", { ...DEFAULT_SETTINGS, volume: 1.2 }],
    ["volume below 0", { ...DEFAULT_SETTINGS, volume: -0.1 }],
    ["startWithWindows not a boolean", { ...DEFAULT_SETTINGS, startWithWindows: "yes" }],
    ["NaN interval", { ...DEFAULT_SETTINGS, intervalMs: Number.NaN }],
  ])("rejects: %s", (_label, input) => {
    const result = parseSettings(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it("collects every validation issue, not just the first", () => {
    const result = parseSettings({ ...DEFAULT_SETTINGS, intervalMs: -1, volume: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.stringContaining("intervalMs"),
          expect.stringContaining("volume"),
        ]),
      );
    }
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseSettings, withDefaults } from "./settings";

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
  ])("rejects: %s", (_label, input) => {
    const result = parseSettings(input);
    expect(result.ok).toBe(false);
  });

  it("rejects a reminder interval below the 60s floor with a path-qualified message", () => {
    const bad = {
      ...DEFAULT_SETTINGS,
      reminders: {
        ...DEFAULT_SETTINGS.reminders,
        hydration: { ...DEFAULT_SETTINGS.reminders.hydration, intervalMs: 500 },
      },
    };
    const result = parseSettings(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual(
        expect.arrayContaining([expect.stringContaining("reminders.hydration.intervalMs must be >= 60000")]),
      );
    }
  });

  it("rejects a pomodoro.longBreakMs below the 60s floor with a path-qualified message", () => {
    const bad = {
      ...DEFAULT_SETTINGS,
      pomodoro: { ...DEFAULT_SETTINGS.pomodoro, longBreakMs: 500 },
    };
    const result = parseSettings(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual(
        expect.arrayContaining([expect.stringContaining("pomodoro.longBreakMs must be >= 60000")]),
      );
    }
  });

  it("rejects an invalid pomodoro alertStyle with a path-qualified message", () => {
    const bad = {
      ...DEFAULT_SETTINGS,
      pomodoro: { ...DEFAULT_SETTINGS.pomodoro, alertStyle: "banner" },
    };
    const result = parseSettings(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual(
        expect.arrayContaining([expect.stringContaining("pomodoro.alertStyle must be one of")]),
      );
    }
  });

  it("rejects a non-positive water bottleOz", () => {
    const bad = { ...DEFAULT_SETTINGS, water: { ...DEFAULT_SETTINGS.water, bottleOz: 0 } };
    const result = parseSettings(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining("water.bottleOz")]));
    }
  });

  it("rejects an idlePause.thresholdSeconds outside its bounds with a path-qualified message", () => {
    const bad = { ...DEFAULT_SETTINGS, idlePause: { ...DEFAULT_SETTINGS.idlePause, thresholdSeconds: 2 } };
    const result = parseSettings(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual(
        expect.arrayContaining([expect.stringContaining("idlePause.thresholdSeconds must be >= 5")]),
      );
    }
  });

  it("rejects a non-boolean cv.enabled with a path-qualified message", () => {
    const bad = { ...DEFAULT_SETTINGS, cv: { enabled: "yes" } };
    const result = parseSettings(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining("cv.enabled must be a boolean")]));
    }
  });

  it("collects every validation issue across nested and top-level fields, not just the first", () => {
    const bad = {
      ...DEFAULT_SETTINGS,
      snoozeMs: -1,
      volume: 5,
      water: { ...DEFAULT_SETTINGS.water, bottleOz: -1 },
    };
    const result = parseSettings(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.stringContaining("snoozeMs"),
          expect.stringContaining("volume"),
          expect.stringContaining("water.bottleOz"),
        ]),
      );
    }
  });
});

describe("withDefaults", () => {
  it("fills a v1-shaped flat settings file with the new nested shape without dropping preserved scalars", () => {
    const v1Shaped = {
      intervalMs: 3 * 60 * 60 * 1000, // no longer a top-level field in v2 — silently dropped
      snoozeMs: 10 * 60 * 1000, // same field name in v2 — must be preserved
      maxSnoozes: 2,
      volume: 0.4,
      startWithWindows: true,
    };

    const merged = withDefaults(v1Shaped);
    const result = parseSettings(merged);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.reminders).toEqual(DEFAULT_SETTINGS.reminders);
      expect(result.value.pomodoro).toEqual(DEFAULT_SETTINGS.pomodoro);
      expect(result.value.water).toEqual(DEFAULT_SETTINGS.water);
      expect(result.value.snoozeMs).toBe(10 * 60 * 1000);
      expect(result.value.maxSnoozes).toBe(2);
      expect(result.value.volume).toBe(0.4);
      expect(result.value.startWithWindows).toBe(true);
    }
  });

  it("fills only the missing leaf when a stored file is missing water.bottleOz", () => {
    const stored = {
      ...DEFAULT_SETTINGS,
      water: { dailyGoalOz: 96 }, // bottleOz missing — e.g. added after this file was written
    };

    const merged = withDefaults(stored);
    const result = parseSettings(merged);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.water).toEqual({ bottleOz: DEFAULT_SETTINGS.water.bottleOz, dailyGoalOz: 96 });
    }
  });

  it("fills an entirely missing top-level section (e.g. water added after this file existed)", () => {
    const stored = {
      reminders: DEFAULT_SETTINGS.reminders,
      pomodoro: DEFAULT_SETTINGS.pomodoro,
      snoozeMs: DEFAULT_SETTINGS.snoozeMs,
      maxSnoozes: DEFAULT_SETTINGS.maxSnoozes,
      volume: DEFAULT_SETTINGS.volume,
      startWithWindows: DEFAULT_SETTINGS.startWithWindows,
    };

    const merged = withDefaults(stored);
    const result = parseSettings(merged);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.water).toEqual(DEFAULT_SETTINGS.water);
    }
  });

  it("passes a present-but-wrong-typed value through unchanged, so parseSettings can report it", () => {
    const merged = withDefaults({ ...DEFAULT_SETTINGS, volume: "loud" });
    const result = parseSettings(merged);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining("volume must be a number")]));
    }
  });

  it("is a no-op on an already-complete settings object", () => {
    expect(withDefaults(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it("fills idlePause with the default when reading a settings file written before that field existed", () => {
    const stored = {
      reminders: DEFAULT_SETTINGS.reminders,
      pomodoro: DEFAULT_SETTINGS.pomodoro,
      water: DEFAULT_SETTINGS.water,
      snoozeMs: DEFAULT_SETTINGS.snoozeMs,
      maxSnoozes: DEFAULT_SETTINGS.maxSnoozes,
      volume: DEFAULT_SETTINGS.volume,
      startWithWindows: DEFAULT_SETTINGS.startWithWindows,
    };

    const merged = withDefaults(stored);
    const result = parseSettings(merged);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.idlePause).toEqual(DEFAULT_SETTINGS.idlePause);
    }
  });

  it("fills pomodoro.longBreakMs with the default when reading a settings file written before that field existed", () => {
    const { longBreakMs: _omitted, ...legacyPomodoro } = DEFAULT_SETTINGS.pomodoro;
    const stored = { ...DEFAULT_SETTINGS, pomodoro: legacyPomodoro };

    const merged = withDefaults(stored);
    const result = parseSettings(merged);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pomodoro).toEqual(DEFAULT_SETTINGS.pomodoro);
    }
  });

  it("fills cv with the default when reading a settings file written before that field existed", () => {
    const stored = {
      reminders: DEFAULT_SETTINGS.reminders,
      pomodoro: DEFAULT_SETTINGS.pomodoro,
      water: DEFAULT_SETTINGS.water,
      idlePause: DEFAULT_SETTINGS.idlePause,
      snoozeMs: DEFAULT_SETTINGS.snoozeMs,
      maxSnoozes: DEFAULT_SETTINGS.maxSnoozes,
      volume: DEFAULT_SETTINGS.volume,
      startWithWindows: DEFAULT_SETTINGS.startWithWindows,
    };

    const merged = withDefaults(stored);
    const result = parseSettings(merged);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cv).toEqual(DEFAULT_SETTINGS.cv);
    }
  });
});

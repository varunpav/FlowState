import { describe, expect, it } from "vitest";
import type { PomodoroState } from "./pomodoro";
import { DEFAULT_SETTINGS, type Settings } from "./settings";
import { timerRowModel } from "./timerRow";

function settings(overrides: (s: Settings) => void): Settings {
  const s: Settings = structuredClone(DEFAULT_SETTINGS);
  overrides(s);
  return s;
}

const FOCUS: PomodoroState = { phase: "focus", completedBlocks: 0 };
const BREAK: PomodoroState = { phase: "break", completedBlocks: 1 };

describe("timerRowModel — hero", () => {
  it("is 'off' when hydration is disabled, regardless of any stray budget", () => {
    const s = settings((x) => {
      x.reminders.hydration.enabled = false;
    });
    const model = timerRowModel(s, FOCUS, [{ kind: "hydration", remainingMs: 42_000 }]);
    expect(model.hero).toEqual({ state: "off", remainingMs: null });
  });

  it("is 'idle' when hydration is enabled but unarmed", () => {
    const model = timerRowModel(DEFAULT_SETTINGS, FOCUS, [{ kind: "hydration", remainingMs: null }]);
    expect(model.hero).toEqual({ state: "idle", remainingMs: null });
  });

  it("is 'idle' when hydration has no snapshot entry at all", () => {
    const model = timerRowModel(DEFAULT_SETTINGS, FOCUS, []);
    expect(model.hero).toEqual({ state: "idle", remainingMs: null });
  });

  it("is 'running' with the live remaining time when hydration is armed", () => {
    const model = timerRowModel(DEFAULT_SETTINGS, FOCUS, [{ kind: "hydration", remainingMs: 90_000 }]);
    expect(model.hero).toEqual({ state: "running", remainingMs: 90_000 });
  });
});

describe("timerRowModel — secondary row", () => {
  it("excludes disabled kinds", () => {
    const model = timerRowModel(DEFAULT_SETTINGS, FOCUS, []);
    // eyeBreak/standUp/pomodoro all default to disabled.
    expect(model.secondary).toEqual([]);
  });

  it("previews an enabled-but-unarmed kind at its configured interval, not a blank", () => {
    const s = settings((x) => {
      x.reminders.eyeBreak.enabled = true;
    });
    const model = timerRowModel(s, FOCUS, []);
    expect(model.secondary).toEqual([
      { kind: "eyeBreak", label: "Eye break", displayMs: DEFAULT_SETTINGS.reminders.eyeBreak.intervalMs, running: false },
    ]);
  });

  it("shows the live remaining time for an armed kind", () => {
    const s = settings((x) => {
      x.reminders.standUp.enabled = true;
    });
    const model = timerRowModel(s, FOCUS, [{ kind: "standUp", remainingMs: 12_345 }]);
    expect(model.secondary).toEqual([{ kind: "standUp", label: "Stand up", displayMs: 12_345, running: true }]);
  });

  it("keeps REMINDER_KINDS order (pomodoro, eyeBreak, standUp) regardless of enable order", () => {
    const s = settings((x) => {
      x.reminders.standUp.enabled = true;
      x.reminders.eyeBreak.enabled = true;
      x.pomodoro.enabled = true;
    });
    const model = timerRowModel(s, FOCUS, []);
    expect(model.secondary.map((e) => e.kind)).toEqual(["pomodoro", "eyeBreak", "standUp"]);
  });

  it("labels a running Pomodoro by its actual phase — Focus", () => {
    const s = settings((x) => {
      x.pomodoro.enabled = true;
    });
    const model = timerRowModel(s, FOCUS, [{ kind: "pomodoro", remainingMs: 1_000 }]);
    expect(model.secondary[0]).toMatchObject({ label: "Pomodoro · Focus", running: true });
  });

  it("labels a running Pomodoro by its actual phase — Break", () => {
    const s = settings((x) => {
      x.pomodoro.enabled = true;
    });
    const model = timerRowModel(s, BREAK, [{ kind: "pomodoro", remainingMs: 1_000 }]);
    expect(model.secondary[0]).toMatchObject({ label: "Pomodoro · Break", running: true });
  });

  it("previews an idle Pomodoro as Focus at focusMs even when the persisted phase is Break", () => {
    const s = settings((x) => {
      x.pomodoro.enabled = true;
      x.pomodoro.focusMs = 55 * 60_000;
    });
    const model = timerRowModel(s, BREAK, []);
    expect(model.secondary[0]).toEqual({
      kind: "pomodoro",
      label: "Pomodoro · Focus",
      displayMs: 55 * 60_000,
      running: false,
    });
  });
});

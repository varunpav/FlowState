import { describe, expect, it } from "vitest";
import { nextDue, reconcileReminders } from "./reminders";

describe("nextDue", () => {
  it("returns null when nothing is armed", () => {
    expect(nextDue([])).toBeNull();
  });

  it("returns the only armed reminder", () => {
    expect(nextDue([{ kind: "eyeBreak", remainingMs: 500 }])).toEqual({
      kind: "eyeBreak",
      remainingMs: 500,
    });
  });

  it("picks the reminder with the least time remaining", () => {
    const armed = [
      { kind: "hydration" as const, remainingMs: 90_000 },
      { kind: "standUp" as const, remainingMs: 10_000 },
      { kind: "pomodoro" as const, remainingMs: 45_000 },
    ];
    expect(nextDue(armed)?.kind).toBe("standUp");
  });

  it("breaks ties by REMINDER_KINDS priority order, not array order", () => {
    const armed = [
      { kind: "standUp" as const, remainingMs: 1_000 },
      { kind: "hydration" as const, remainingMs: 1_000 },
    ];
    expect(nextDue(armed)?.kind).toBe("hydration");
  });
});

describe("reconcileReminders", () => {
  it("never arms an enabled reminder with no live budget — enabling is not arming", () => {
    const actions = reconcileReminders([{ kind: "eyeBreak", enabled: true, currentRemainingMs: null }]);
    expect(actions).toEqual([]);
  });

  it("disarms a newly-disabled reminder that still has a live budget", () => {
    const actions = reconcileReminders([{ kind: "standUp", enabled: false, currentRemainingMs: 500_000 }]);
    expect(actions).toEqual([{ kind: "standUp", ms: null }]);
  });

  it("leaves an already-consistent enabled reminder untouched (in-progress countdown survives)", () => {
    const actions = reconcileReminders([{ kind: "hydration", enabled: true, currentRemainingMs: 3_000_000 }]);
    expect(actions).toEqual([]);
  });

  it("leaves an already-consistent disabled reminder untouched", () => {
    const actions = reconcileReminders([{ kind: "pomodoro", enabled: false, currentRemainingMs: null }]);
    expect(actions).toEqual([]);
  });
});

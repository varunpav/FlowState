import { describe, expect, it } from "vitest";
import { applySnooze, resetSnoozeState } from "./snooze";

describe("applySnooze", () => {
  const config = { snoozeMs: 5 * 60 * 1000, maxSnoozes: 2 };

  it("sets the next deadline relative to now, not the missed deadline", () => {
    const state = resetSnoozeState();
    const now = 1_000_000;
    const result = applySnooze(state, now, config);
    expect(result).toEqual({
      ok: true,
      nextDeadline: now + config.snoozeMs,
      state: { snoozeCount: 1 },
    });
  });

  it("increments snoozeCount on each call", () => {
    let state = resetSnoozeState();
    const first = applySnooze(state, 0, config);
    expect(first.ok).toBe(true);
    state = (first as Extract<typeof first, { ok: true }>).state;
    expect(state.snoozeCount).toBe(1);

    const second = applySnooze(state, 10_000, config);
    expect(second.ok).toBe(true);
    state = (second as Extract<typeof second, { ok: true }>).state;
    expect(state.snoozeCount).toBe(2);
  });

  it("rejects snoozing past maxSnoozes", () => {
    const state = { snoozeCount: 2 };
    const result = applySnooze(state, 0, config);
    expect(result).toEqual({ ok: false, reason: "max-snoozes-reached" });
  });

  it("does not mutate the input state", () => {
    const state = { snoozeCount: 0 };
    applySnooze(state, 0, config);
    expect(state.snoozeCount).toBe(0);
  });
});

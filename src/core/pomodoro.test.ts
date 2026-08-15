import { describe, expect, it } from "vitest";
import { advancePomodoro, initialPomodoroState } from "./pomodoro";

const CONFIG = { focusMs: 25 * 60 * 1000, breakMs: 5 * 60 * 1000 };

describe("initialPomodoroState", () => {
  it("starts in focus with zero completed blocks", () => {
    expect(initialPomodoroState()).toEqual({ phase: "focus", completedBlocks: 0 });
  });
});

describe("advancePomodoro", () => {
  it("moves focus -> break, increments completedBlocks, and does not pause when idle", () => {
    const result = advancePomodoro({ phase: "focus", completedBlocks: 0 }, CONFIG);
    expect(result.state).toEqual({ phase: "break", completedBlocks: 1 });
    expect(result.nextBudgetMs).toBe(CONFIG.breakMs);
    expect(result.pauseWhenIdle).toBe(false);
  });

  it("moves break -> focus, leaves completedBlocks unchanged, and pauses when idle", () => {
    const result = advancePomodoro({ phase: "break", completedBlocks: 1 }, CONFIG);
    expect(result.state).toEqual({ phase: "focus", completedBlocks: 1 });
    expect(result.nextBudgetMs).toBe(CONFIG.focusMs);
    expect(result.pauseWhenIdle).toBe(true);
  });

  it("accumulates completedBlocks across multiple focus/break cycles", () => {
    let state = initialPomodoroState();
    for (let i = 0; i < 3; i++) {
      state = advancePomodoro(state, CONFIG).state; // focus -> break
      state = advancePomodoro(state, CONFIG).state; // break -> focus
    }
    expect(state).toEqual({ phase: "focus", completedBlocks: 3 });
  });
});

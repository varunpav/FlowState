export type PomodoroPhase = "focus" | "break";

export interface PomodoroConfig {
  focusMs: number;
  breakMs: number;
}

export interface PomodoroState {
  phase: PomodoroPhase;
  completedBlocks: number;
}

export interface PomodoroAdvance {
  state: PomodoroState;
  nextBudgetMs: number;
  /**
   * False only for the break. Walking away from the desk IS the break, so
   * its budget must not pause when idle the way every other reminder's does
   * — pausing it would mean the break never ends until you sit back down
   * and then wait out the remainder. This is the one exception to Rust's
   * global "inactivity pauses everything" rule (scheduler.rs).
   */
  pauseWhenIdle: boolean;
}

export function initialPomodoroState(): PomodoroState {
  return { phase: "focus", completedBlocks: 0 };
}

/**
 * Called when the current phase's budget reaches zero — decides what phase
 * comes next and what its budget/pause behavior should be. Pure policy: the
 * "long break every 4th block" rule was explicitly not requested, so it
 * isn't here — just 25|55 focus alternating with 5|15 break, full stop.
 */
export function advancePomodoro(state: PomodoroState, config: PomodoroConfig): PomodoroAdvance {
  if (state.phase === "focus") {
    return {
      state: { phase: "break", completedBlocks: state.completedBlocks + 1 },
      nextBudgetMs: config.breakMs,
      pauseWhenIdle: false,
    };
  }
  return {
    state: { phase: "focus", completedBlocks: state.completedBlocks },
    nextBudgetMs: config.focusMs,
    pauseWhenIdle: true,
  };
}

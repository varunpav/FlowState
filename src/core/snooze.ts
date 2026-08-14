export interface SnoozeConfig {
  snoozeMs: number;
  maxSnoozes: number;
}

export interface SnoozeState {
  snoozeCount: number;
}

export type SnoozeResult =
  | { ok: true; nextDeadline: number; state: SnoozeState }
  | { ok: false; reason: "max-snoozes-reached" };

/**
 * The new deadline is `now + snoozeMs`, not `oldDeadline + snoozeMs` — snoozing
 * always buys a fixed grace period from the moment of the snooze, regardless of
 * how late the takeover was acknowledged.
 */
export function applySnooze(state: SnoozeState, now: number, config: SnoozeConfig): SnoozeResult {
  if (state.snoozeCount >= config.maxSnoozes) {
    return { ok: false, reason: "max-snoozes-reached" };
  }
  return {
    ok: true,
    nextDeadline: now + config.snoozeMs,
    state: { snoozeCount: state.snoozeCount + 1 },
  };
}

export function resetSnoozeState(): SnoozeState {
  return { snoozeCount: 0 };
}

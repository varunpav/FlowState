export type ReminderKind = "hydration" | "pomodoro" | "eyeBreak" | "standUp";
export type AlertStyle = "takeover" | "notify";

export const ALERT_STYLES: readonly AlertStyle[] = ["takeover", "notify"];

/**
 * Also doubles as Rust's takeover promotion priority (scheduler.rs's
 * `[Reminder; 4]` iteration order) — keep these two orderings identical.
 */
export const REMINDER_KINDS: readonly ReminderKind[] = ["hydration", "pomodoro", "eyeBreak", "standUp"];

export const REMINDER_LABELS: Record<ReminderKind, string> = {
  hydration: "Hydration",
  pomodoro: "Pomodoro",
  eyeBreak: "Eye break",
  standUp: "Stand up",
};

export interface ArmedReminder {
  kind: ReminderKind;
  remainingMs: number;
}

/**
 * Picks the home page hero: the armed reminder with the least time left.
 * Ties (equal remainingMs) break by REMINDER_KINDS order so the choice is
 * deterministic rather than depending on array insertion order.
 */
export function nextDue(armed: readonly ArmedReminder[]): ArmedReminder | null {
  let best: ArmedReminder | null = null;
  for (const kind of REMINDER_KINDS) {
    const candidate = armed.find((a) => a.kind === kind);
    if (!candidate) continue;
    if (best === null || candidate.remainingMs < best.remainingMs) best = candidate;
  }
  return best;
}

export interface ReconcileInput {
  kind: ReminderKind;
  enabled: boolean;
  intervalMs: number;
  currentRemainingMs: number | null;
}

export interface ReconcileAction {
  kind: ReminderKind;
  ms: number | null;
}

/**
 * Decides which reminders need a fresh arm/disarm IPC call after a settings
 * change (including at startup) — an enabled reminder with no live budget
 * gets armed with a full interval; a disabled reminder with a live budget
 * gets cleared. An already-consistent reminder produces no action, so an
 * in-progress countdown survives a settings save that didn't touch it, and
 * a restart resumes exactly where it left off rather than snapping back to
 * a full interval.
 */
export function reconcileReminders(inputs: readonly ReconcileInput[]): ReconcileAction[] {
  const actions: ReconcileAction[] = [];
  for (const input of inputs) {
    if (input.enabled && input.currentRemainingMs === null) {
      actions.push({ kind: input.kind, ms: input.intervalMs });
    } else if (!input.enabled && input.currentRemainingMs !== null) {
      actions.push({ kind: input.kind, ms: null });
    }
  }
  return actions;
}

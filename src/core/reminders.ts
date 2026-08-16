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
  /**
   * True only for a genuine disabled->enabled transition since the last
   * reconcile. Arming is gated on this (not just `enabled`) so a fresh
   * launch — where nothing has "just" become enabled — never starts a
   * countdown on its own; the user arms everything explicitly via Start
   * timer. A reminder enabled mid-session still arms immediately, so
   * toggling one on in Settings doesn't additionally require Start.
   */
  justEnabled: boolean;
  intervalMs: number;
  currentRemainingMs: number | null;
}

export interface ReconcileAction {
  kind: ReminderKind;
  ms: number | null;
}

/**
 * Decides which reminders need a fresh arm/disarm IPC call after a settings
 * change — a reminder that just became enabled and has no live budget gets
 * armed with a full interval; a disabled reminder with a live budget gets
 * cleared. Neither an already-consistent reminder nor a startup restore
 * (where nothing is `justEnabled`) produces an action, so an in-progress
 * countdown survives a settings change that didn't touch it, a restart
 * resumes exactly where it left off, and a cold launch stays idle until the
 * user presses Start.
 */
export function reconcileReminders(inputs: readonly ReconcileInput[]): ReconcileAction[] {
  const actions: ReconcileAction[] = [];
  for (const input of inputs) {
    if (input.justEnabled && input.currentRemainingMs === null) {
      actions.push({ kind: input.kind, ms: input.intervalMs });
    } else if (!input.enabled && input.currentRemainingMs !== null) {
      actions.push({ kind: input.kind, ms: null });
    }
  }
  return actions;
}

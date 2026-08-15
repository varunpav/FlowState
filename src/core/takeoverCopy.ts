import type { ReminderKind } from "./reminders";
import type { PomodoroPhase } from "./pomodoro";

export interface TakeoverCopy {
  title: string;
  confirmLabel: string;
  notificationBody: string;
}

/**
 * Eye break is a plain prompt with a Done button — no timed 20-second
 * countdown (explicit user decision, overriding the design agent's
 * recommendation to time it).
 */
const STATIC_COPY: Record<Exclude<ReminderKind, "pomodoro">, TakeoverCopy> = {
  hydration: {
    title: "Time to hydrate",
    confirmLabel: "I drank water",
    notificationBody: "Time to hydrate",
  },
  eyeBreak: {
    title: "Look 20 feet away for 20 seconds",
    confirmLabel: "Done",
    notificationBody: "Eye break — look 20 feet away for 20 seconds",
  },
  standUp: {
    title: "Stand up and stretch",
    confirmLabel: "Done",
    notificationBody: "Time to stand up and stretch",
  },
};

/**
 * Pomodoro copy depends on which phase just ended, not just the kind —
 * confirming a finished focus block starts the break, and confirming a
 * finished break returns to focus.
 */
export function pomodoroCopy(phaseJustEnded: PomodoroPhase): TakeoverCopy {
  return phaseJustEnded === "focus"
    ? {
        title: "Focus session complete",
        confirmLabel: "Start break",
        notificationBody: "Focus session complete — take a break",
      }
    : {
        title: "Break's over",
        confirmLabel: "Back to focus",
        notificationBody: "Break's over — back to focus",
      };
}

export function takeoverCopyFor(kind: ReminderKind, pomodoroPhaseJustEnded?: PomodoroPhase): TakeoverCopy {
  if (kind === "pomodoro") {
    return pomodoroCopy(pomodoroPhaseJustEnded ?? "focus");
  }
  return STATIC_COPY[kind];
}

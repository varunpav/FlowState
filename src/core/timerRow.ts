import type { PomodoroPhase, PomodoroState } from "./pomodoro";
import { REMINDER_KINDS, REMINDER_LABELS, type ReminderKind } from "./reminders";
import type { Settings } from "./settings";

export type HydrationHeroState = "running" | "idle" | "off";

export interface HeroModel {
  state: HydrationHeroState;
  /** Only ever non-null when `state === "running"`. */
  remainingMs: number | null;
}

/** One row entry for a non-hydration timer shown under the hero. */
export interface TimerRowEntry {
  kind: ReminderKind;
  /** "Eye break" | "Pomodoro · Focus" | "Pomodoro · Break" — Pomodoro's label depends on phase. */
  label: string;
  /** Live remaining time while running; the configured length as a preview while idle. */
  displayMs: number;
  running: boolean;
}

export interface TimerRowModel {
  hero: HeroModel;
  secondary: TimerRowEntry[];
}

/** Minimal shape this module needs from a reminder snapshot — kept local so core/ has no dependency on ipc.ts. */
export interface ReminderRemaining {
  kind: ReminderKind;
  remainingMs: number | null;
}

function isKindEnabled(settings: Settings, kind: Exclude<ReminderKind, "hydration">): boolean {
  return kind === "pomodoro" ? settings.pomodoro.enabled : settings.reminders[kind].enabled;
}

function pomodoroLabel(phase: PomodoroPhase): string {
  return phase === "focus" ? "Pomodoro · Focus" : "Pomodoro · Break";
}

/**
 * Pure policy for what the home page's timer row should show — no DOM, no
 * IPC, fully unit-testable. Two rules worth calling out:
 *
 * - Hydration switched off is its own hero state ("off"), distinct from
 *   "idle" (enabled but not yet armed) — so the hero can say *why* it isn't
 *   counting instead of looking indistinguishable from "not started yet".
 * - An idle Pomodoro entry always previews Focus at `focusMs`, never the
 *   persisted phase. Start unconditionally resets the phase to focus (see
 *   main.ts), so previewing a restored break phase would advertise a
 *   duration Start will not actually deliver.
 */
export function timerRowModel(
  settings: Settings,
  pomodoroState: PomodoroState,
  snapshot: readonly ReminderRemaining[],
): TimerRowModel {
  const remainingOf = (kind: ReminderKind) => snapshot.find((r) => r.kind === kind)?.remainingMs ?? null;

  const hydrationRemaining = remainingOf("hydration");
  const hero: HeroModel = !settings.reminders.hydration.enabled
    ? { state: "off", remainingMs: null }
    : hydrationRemaining === null
      ? { state: "idle", remainingMs: null }
      : { state: "running", remainingMs: hydrationRemaining };

  const secondary: TimerRowEntry[] = REMINDER_KINDS.filter(
    (k): k is Exclude<ReminderKind, "hydration"> => k !== "hydration",
  )
    .filter((kind) => isKindEnabled(settings, kind))
    .map((kind) => {
      const remainingMs = remainingOf(kind);
      const running = remainingMs !== null;

      if (kind === "pomodoro") {
        const phase: PomodoroPhase = running ? pomodoroState.phase : "focus";
        const displayMs = remainingMs !== null ? remainingMs : settings.pomodoro.focusMs;
        return { kind, label: pomodoroLabel(phase), displayMs, running };
      }

      const displayMs = remainingMs !== null ? remainingMs : settings.reminders[kind].intervalMs;
      return { kind, label: REMINDER_LABELS[kind], displayMs, running };
    });

  return { hero, secondary };
}

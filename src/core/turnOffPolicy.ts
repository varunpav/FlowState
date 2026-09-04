import type { ReminderKind } from "./reminders";

/**
 * Whether the takeover's "Turn off" button should be offered right now.
 *
 * Hydration is gated behind having snoozed at least once — it's the app's
 * core purpose, so the off switch is an escape hatch for someone already
 * dodging it rather than a first-glance option that could get hit by
 * accident on the very first takeover. Every other kind (Pomodoro, eye
 * break, stand up) offers it immediately; there's no equivalent "this is
 * the whole point of the app" reason to hide it there.
 */
export function shouldOfferTurnOff(kind: ReminderKind, snoozeCount: number): boolean {
  if (kind === "hydration") return snoozeCount >= 1;
  return true;
}

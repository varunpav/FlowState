import { addDays } from "./waterLog";

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
const MONTH_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * "Today" / "Yesterday" / "Wed Aug 13" — for the Settings water-history day
 * picker. Formatted as a UTC date (matching `dayKeyOf`'s pure-UTC day keys)
 * rather than through the host's local Date, so it can't drift a day off
 * near a timezone boundary the way constructing `new Date("YYYY-MM-DD")`
 * and reading local getters would.
 */
export function relativeDayLabel(dayKey: string, todayKey: string): string {
  if (dayKey === todayKey) return "Today";
  if (dayKey === addDays(todayKey, -1)) return "Yesterday";

  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return `${WEEKDAY_FORMATTER.format(date)} ${MONTH_DAY_FORMATTER.format(date)}`;
}

/**
 * "7:42 PM" — the idle-hero placeholder shown before hydration is armed.
 * Deliberately the one formatter in this module that uses the *local*
 * timezone (timeZone left undefined defers to the host) rather than UTC:
 * this renders a wall clock for the user to read, not a day key, so the
 * pure-UTC discipline the rest of this module follows doesn't apply here.
 * Tests pass `"UTC"` explicitly so results don't depend on the host's zone.
 */
export function formatClockTime(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(
    new Date(ms),
  );
}

export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

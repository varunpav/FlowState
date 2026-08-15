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

export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

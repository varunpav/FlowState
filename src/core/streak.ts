export type DailyLog = Record<string, number>;

/**
 * Pure day-key derivation over a UTC-shifted timestamp — deliberately does NOT
 * touch the host's local Date methods (getMonth/getDate/etc), so it never depends
 * on the machine's timezone and is immune to DST rules. `tzOffsetMinutes` follows
 * the "UTC+X" convention: local = utc + tzOffsetMinutes (e.g. US Eastern standard
 * time, UTC-5, is -300).
 */
export function dayKeyOf(nowMs: number, tzOffsetMinutes: number): string {
  const localMs = nowMs + tzOffsetMinutes * 60_000;
  const d = new Date(localMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function updateLog(log: DailyLog, dayKey: string): DailyLog {
  return { ...log, [dayKey]: (log[dayKey] ?? 0) + 1 };
}

export function currentStreak(log: DailyLog, todayKey: string): number {
  let streak = 0;
  let cursor = todayKey;
  while ((log[cursor] ?? 0) > 0) {
    streak++;
    cursor = previousDayKey(cursor);
  }
  return streak;
}

function previousDayKey(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  const prevUtcMs = Date.UTC(year, month - 1, day) - 24 * 60 * 60 * 1000;
  const prev = new Date(prevUtcMs);
  const y = prev.getUTCFullYear();
  const m = String(prev.getUTCMonth() + 1).padStart(2, "0");
  const d = String(prev.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

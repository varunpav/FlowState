export interface DayEntry {
  oz: number;
  count: number;
}

export type DailyLog = Record<string, DayEntry>;

export const DAILY_GOAL_OZ = 128;

const EMPTY_ENTRY: DayEntry = { oz: 0, count: 0 };

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

/**
 * "YYYY-MM-DD" is lexicographically sortable, so every range/streak function
 * below compares day keys with plain string `<`/`<=` instead of parsing them
 * back into dates.
 */
export function addDays(dayKey: string, delta: number): string {
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  const shiftedMs = Date.UTC(year, month - 1, day) + delta * 24 * 60 * 60 * 1000;
  const d = new Date(shiftedMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function entryOn(log: DailyLog, dayKey: string): DayEntry {
  return log[dayKey] ?? EMPTY_ENTRY;
}

export function logWater(log: DailyLog, dayKey: string, oz: number): DailyLog {
  const prev = entryOn(log, dayKey);
  return { ...log, [dayKey]: { oz: prev.oz + oz, count: prev.count + 1 } };
}

/**
 * Both fields floor at 0 — removing more than was logged must land on 0,
 * never negative. A negative day would corrupt `rangeStats`' average and
 * `goalStreak`'s >= comparison downstream.
 */
export function removeWater(log: DailyLog, dayKey: string, oz: number): DailyLog {
  const prev = entryOn(log, dayKey);
  return { ...log, [dayKey]: { oz: Math.max(0, prev.oz - oz), count: Math.max(0, prev.count - 1) } };
}

export function clearDay(log: DailyLog, dayKey: string): DailyLog {
  return { ...log, [dayKey]: { oz: 0, count: 0 } };
}

export interface DayBar {
  dayKey: string;
  entry: DayEntry;
}

/** Oldest-to-newest, `n` entries ending at (and including) `todayKey`. */
export function lastNDays(log: DailyLog, todayKey: string, n: number): DayBar[] {
  const days: DayBar[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const dayKey = addDays(todayKey, -i);
    days.push({ dayKey, entry: entryOn(log, dayKey) });
  }
  return days;
}

export interface RangeStats {
  avgOzPerDay: number;
  daysAtGoal: number;
  daysCounted: number;
}

/**
 * `daysCounted` runs from the first logged day in [startKey, endKey] through
 * endKey — NOT "days with data" (a single 128oz day would then report "avg
 * 128 oz/day" regardless of range length) and NOT the full calendar range (a
 * year-to-date query for a brand-new user would divide by every day since
 * January 1st and report ~8oz/day). Both of those read as bugs; this is the
 * one reading that's actually "your average since you started logging."
 */
export function rangeStats(
  log: DailyLog,
  startKey: string,
  endKey: string,
  goalOz: number = DAILY_GOAL_OZ,
): RangeStats {
  const keys: string[] = [];
  for (let cursor = startKey; cursor <= endKey; cursor = addDays(cursor, 1)) {
    keys.push(cursor);
  }

  const firstLoggedIndex = keys.findIndex((k) => entryOn(log, k).count > 0);
  if (firstLoggedIndex === -1) {
    return { avgOzPerDay: 0, daysAtGoal: 0, daysCounted: 0 };
  }

  const countedKeys = keys.slice(firstLoggedIndex);
  const totalOz = countedKeys.reduce((sum, k) => sum + entryOn(log, k).oz, 0);
  const daysAtGoal = countedKeys.filter((k) => entryOn(log, k).oz >= goalOz).length;

  return {
    avgOzPerDay: totalOz / countedKeys.length,
    daysAtGoal,
    daysCounted: countedKeys.length,
  };
}

function firstOfMonth(dayKey: string): string {
  const [year, month] = dayKey.split("-");
  return `${year}-${month}-01`;
}

function firstOfYear(dayKey: string): string {
  const [year] = dayKey.split("-");
  return `${year}-01-01`;
}

export function monthToDate(log: DailyLog, todayKey: string, goalOz: number = DAILY_GOAL_OZ): RangeStats {
  return rangeStats(log, firstOfMonth(todayKey), todayKey, goalOz);
}

export function yearToDate(log: DailyLog, todayKey: string, goalOz: number = DAILY_GOAL_OZ): RangeStats {
  return rangeStats(log, firstOfYear(todayKey), todayKey, goalOz);
}

/**
 * Consecutive days hitting goal, counting back from today if today already
 * hit it, otherwise from yesterday. Without the trailing-day rule the streak
 * would read 0 every morning and for most of every day (today hasn't hit
 * goal yet by definition, most of the day) — actively demoralizing for the
 * one number meant to motivate.
 */
export function goalStreak(log: DailyLog, todayKey: string, goalOz: number = DAILY_GOAL_OZ): number {
  let cursor = entryOn(log, todayKey).oz >= goalOz ? todayKey : addDays(todayKey, -1);
  let streak = 0;
  while (entryOn(log, cursor).oz >= goalOz) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/**
 * Best-effort and never throws — a corrupt log day must not block startup.
 * Deliberately a DIFFERENT contract from `parseSettings`, which returns a
 * result union because bad settings are actionable (the user can fix them in
 * the Settings page); a bad water-log day is just noise to drop.
 *
 * v1 log entries were plain numbers (a confirmation count). They become
 * `{ oz: 0, count: n }` — NOT `{ oz: n * bottleOz, count: n }`. Backfilling
 * ounces from a count would fabricate volume the user never actually
 * entered, which would corrupt the goal streak with invented data.
 */
export function normalizeLog(raw: unknown): DailyLog {
  if (typeof raw !== "object" || raw === null) return {};

  const result: DailyLog = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;

    if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0) continue;
      result[key] = { oz: 0, count: value };
      continue;
    }

    if (typeof value === "object" && value !== null) {
      const v = value as Record<string, unknown>;
      const oz = typeof v["oz"] === "number" && Number.isFinite(v["oz"]) && v["oz"] >= 0 ? v["oz"] : 0;
      const count =
        typeof v["count"] === "number" && Number.isFinite(v["count"]) && v["count"] >= 0 ? v["count"] : 0;
      result[key] = { oz, count };
    }
  }
  return result;
}

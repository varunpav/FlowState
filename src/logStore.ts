import { load } from "@tauri-apps/plugin-store";
import type { DailyLog } from "./core/streak";

const STORE_PATH = "log.json";
const LOG_KEY = "dailyLog";

async function getStore() {
  return load(STORE_PATH, { autoSave: false });
}

export async function loadLog(): Promise<DailyLog> {
  const store = await getStore();
  const raw = await store.get<DailyLog>(LOG_KEY);
  return raw ?? {};
}

export async function saveLog(log: DailyLog): Promise<void> {
  const store = await getStore();
  await store.set(LOG_KEY, log);
  await store.save();
}

/**
 * `dayKeyOf` (core/streak.ts) stays pure and takes an explicit tz offset for
 * testability; this is the one non-pure call site that reads the host's
 * actual current offset, in `dayKeyOf`'s "UTC+X" sign convention (opposite
 * of `Date.prototype.getTimezoneOffset()`).
 */
export function localTzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

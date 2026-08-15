import { ALERT_STYLES, type AlertStyle } from "./reminders";

export interface ReminderSettings {
  enabled: boolean;
  intervalMs: number;
  alertStyle: AlertStyle;
}

export interface PomodoroSettings {
  enabled: boolean;
  focusMs: number;
  breakMs: number;
  alertStyle: AlertStyle;
}

export interface WaterSettings {
  bottleOz: number;
  dailyGoalOz: number;
}

export interface RemindersSettings {
  hydration: ReminderSettings;
  eyeBreak: ReminderSettings;
  standUp: ReminderSettings;
}

export interface Settings {
  reminders: RemindersSettings;
  /** Separate from `reminders`: it has no single interval, it alternates focus/break. */
  pomodoro: PomodoroSettings;
  water: WaterSettings;
  snoozeMs: number;
  maxSnoozes: number;
  volume: number;
  startWithWindows: boolean;
}

export type ParseSettingsResult = { ok: true; value: Settings } | { ok: false; issues: string[] };

export const DEFAULT_SETTINGS: Settings = {
  reminders: {
    hydration: { enabled: true, intervalMs: 2 * 60 * 60 * 1000, alertStyle: "takeover" },
    eyeBreak: { enabled: false, intervalMs: 20 * 60 * 1000, alertStyle: "notify" },
    standUp: { enabled: false, intervalMs: 60 * 60 * 1000, alertStyle: "notify" },
  },
  pomodoro: { enabled: false, focusMs: 25 * 60 * 1000, breakMs: 5 * 60 * 1000, alertStyle: "takeover" },
  water: { bottleOz: 24, dailyGoalOz: 128 },
  snoozeMs: 15 * 60 * 1000,
  maxSnoozes: 3,
  volume: 0.7,
  startWithWindows: false,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively fills in whatever `raw` is missing from `DEFAULT_SETTINGS`,
 * called before `parseSettings`. Without this, a stored settings.json
 * missing any newly-added field (schema growth, or a v1-shaped flat file)
 * fails validation as a whole and `settingsStore.loadSettings` silently
 * resets EVERY setting to defaults — not just the missing one.
 *
 * Only fills in values that are `undefined` (the key is genuinely absent).
 * A present-but-wrong-typed value is passed through unchanged so
 * `parseSettings` can report exactly what's wrong with it — this function
 * only prevents "absent" from masquerading as "invalid".
 */
export function withDefaults(raw: unknown): unknown {
  return mergeDefaults(raw, DEFAULT_SETTINGS);
}

function mergeDefaults(raw: unknown, defaults: unknown): unknown {
  if (raw === undefined) return defaults;
  if (!isPlainObject(defaults) || !isPlainObject(raw)) return raw;

  const merged: Record<string, unknown> = { ...raw };
  for (const key of Object.keys(defaults)) {
    merged[key] = mergeDefaults(raw[key], defaults[key]);
  }
  return merged;
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

interface NumberBounds {
  min?: number;
  max?: number;
  integer?: boolean;
}

function num(
  obj: Record<string, unknown>,
  path: string,
  key: string,
  issues: string[],
  bounds: NumberBounds = {},
): number | undefined {
  const value = obj[key];
  const fullPath = joinPath(path, key);
  if (typeof value !== "number" || Number.isNaN(value)) {
    issues.push(`${fullPath} must be a number`);
    return undefined;
  }
  if (bounds.integer === true && !Number.isInteger(value)) {
    issues.push(`${fullPath} must be an integer`);
    return undefined;
  }
  if (bounds.min !== undefined && value < bounds.min) {
    issues.push(`${fullPath} must be >= ${bounds.min}`);
    return undefined;
  }
  if (bounds.max !== undefined && value > bounds.max) {
    issues.push(`${fullPath} must be <= ${bounds.max}`);
    return undefined;
  }
  return value;
}

function bool(obj: Record<string, unknown>, path: string, key: string, issues: string[]): boolean | undefined {
  const value = obj[key];
  const fullPath = joinPath(path, key);
  if (typeof value !== "boolean") {
    issues.push(`${fullPath} must be a boolean`);
    return undefined;
  }
  return value;
}

function oneOf<T extends string>(
  obj: Record<string, unknown>,
  path: string,
  key: string,
  options: readonly T[],
  issues: string[],
): T | undefined {
  const value = obj[key];
  const fullPath = joinPath(path, key);
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
    issues.push(`${fullPath} must be one of: ${options.join(", ")}`);
    return undefined;
  }
  return value as T;
}

function child(
  obj: Record<string, unknown>,
  path: string,
  key: string,
  issues: string[],
): Record<string, unknown> | undefined {
  const value = obj[key];
  const fullPath = joinPath(path, key);
  if (!isPlainObject(value)) {
    issues.push(`${fullPath} must be an object`);
    return undefined;
  }
  return value;
}

function parseReminder(
  remindersObj: Record<string, unknown>,
  remindersPath: string,
  key: string,
  issues: string[],
): ReminderSettings | undefined {
  const raw = child(remindersObj, remindersPath, key, issues);
  if (!raw) return undefined;
  const path = joinPath(remindersPath, key);

  const enabled = bool(raw, path, "enabled", issues);
  const intervalMs = num(raw, path, "intervalMs", issues, { min: 60_000 });
  const alertStyle = oneOf(raw, path, "alertStyle", ALERT_STYLES, issues);
  if (enabled === undefined || intervalMs === undefined || alertStyle === undefined) return undefined;
  return { enabled, intervalMs, alertStyle };
}

function parsePomodoro(obj: Record<string, unknown>, issues: string[]): PomodoroSettings | undefined {
  const raw = child(obj, "", "pomodoro", issues);
  if (!raw) return undefined;
  const path = "pomodoro";

  const enabled = bool(raw, path, "enabled", issues);
  const focusMs = num(raw, path, "focusMs", issues, { min: 60_000 });
  const breakMs = num(raw, path, "breakMs", issues, { min: 60_000 });
  const alertStyle = oneOf(raw, path, "alertStyle", ALERT_STYLES, issues);
  if (enabled === undefined || focusMs === undefined || breakMs === undefined || alertStyle === undefined) {
    return undefined;
  }
  return { enabled, focusMs, breakMs, alertStyle };
}

function parseWater(obj: Record<string, unknown>, issues: string[]): WaterSettings | undefined {
  const raw = child(obj, "", "water", issues);
  if (!raw) return undefined;
  const path = "water";

  const bottleOz = num(raw, path, "bottleOz", issues, { min: 1 });
  const dailyGoalOz = num(raw, path, "dailyGoalOz", issues, { min: 1 });
  if (bottleOz === undefined || dailyGoalOz === undefined) return undefined;
  return { bottleOz, dailyGoalOz };
}

/**
 * Validated at the boundary where JSON returns from the Rust store, rather
 * than deep inside the scheduling engine — callers get a discriminated union
 * instead of a thrown exception, so malformed persisted settings degrade to
 * a clear issue list instead of crashing the app on startup. Collects every
 * issue in one pass rather than bailing at the first, and issue messages are
 * path-qualified (e.g. "reminders.hydration.intervalMs must be >= 60000") so
 * a validation failure is actionable instead of just "settings are bad".
 */
export function parseSettings(input: unknown): ParseSettingsResult {
  const issues: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, issues: ["settings must be an object"] };
  }
  const obj = input;

  const remindersRaw = child(obj, "", "reminders", issues);
  const hydration = remindersRaw ? parseReminder(remindersRaw, "reminders", "hydration", issues) : undefined;
  const eyeBreak = remindersRaw ? parseReminder(remindersRaw, "reminders", "eyeBreak", issues) : undefined;
  const standUp = remindersRaw ? parseReminder(remindersRaw, "reminders", "standUp", issues) : undefined;

  const pomodoro = parsePomodoro(obj, issues);
  const water = parseWater(obj, issues);

  const snoozeMs = num(obj, "", "snoozeMs", issues, { min: 1_000 });
  const maxSnoozes = num(obj, "", "maxSnoozes", issues, { min: 0, integer: true });
  const volume = num(obj, "", "volume", issues, { min: 0, max: 1 });
  const startWithWindows = bool(obj, "", "startWithWindows", issues);

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      reminders: {
        hydration: hydration as ReminderSettings,
        eyeBreak: eyeBreak as ReminderSettings,
        standUp: standUp as ReminderSettings,
      },
      pomodoro: pomodoro as PomodoroSettings,
      water: water as WaterSettings,
      snoozeMs: snoozeMs as number,
      maxSnoozes: maxSnoozes as number,
      volume: volume as number,
      startWithWindows: startWithWindows as boolean,
    },
  };
}

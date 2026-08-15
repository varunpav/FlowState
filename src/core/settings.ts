export interface Settings {
  intervalMs: number;
  snoozeMs: number;
  maxSnoozes: number;
  volume: number;
  startWithWindows: boolean;
}

export type ParseSettingsResult =
  | { ok: true; value: Settings }
  | { ok: false; issues: string[] };

export const DEFAULT_SETTINGS: Settings = {
  intervalMs: 2 * 60 * 60 * 1000,
  snoozeMs: 5 * 60 * 1000,
  maxSnoozes: 3,
  volume: 0.7,
  startWithWindows: false,
};

interface NumberBounds {
  min?: number;
  max?: number;
  integer?: boolean;
}

/**
 * Validated at the boundary where JSON returns from the Rust store, rather than
 * deep inside the scheduling engine — callers get a discriminated union instead
 * of a thrown exception, so malformed persisted settings degrade to a clear
 * issue list instead of crashing the app on startup.
 */
export function parseSettings(input: unknown): ParseSettingsResult {
  const issues: string[] = [];

  if (typeof input !== "object" || input === null) {
    return { ok: false, issues: ["settings must be an object"] };
  }
  const obj = input as Record<string, unknown>;

  const intervalMs = requireNumber(obj, "intervalMs", issues, { min: 60_000 });
  const snoozeMs = requireNumber(obj, "snoozeMs", issues, { min: 1_000 });
  const maxSnoozes = requireNumber(obj, "maxSnoozes", issues, { min: 0, integer: true });
  const volume = requireNumber(obj, "volume", issues, { min: 0, max: 1 });

  const startWithWindowsRaw = obj["startWithWindows"];
  if (typeof startWithWindowsRaw !== "boolean") {
    issues.push("startWithWindows must be a boolean");
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      intervalMs: intervalMs as number,
      snoozeMs: snoozeMs as number,
      maxSnoozes: maxSnoozes as number,
      volume: volume as number,
      startWithWindows: startWithWindowsRaw as boolean,
    },
  };
}

function requireNumber(
  obj: Record<string, unknown>,
  key: string,
  issues: string[],
  bounds: NumberBounds = {},
): number | undefined {
  const value = obj[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    issues.push(`${key} must be a number`);
    return undefined;
  }
  if (bounds.integer === true && !Number.isInteger(value)) {
    issues.push(`${key} must be an integer`);
    return undefined;
  }
  if (bounds.min !== undefined && value < bounds.min) {
    issues.push(`${key} must be >= ${bounds.min}`);
    return undefined;
  }
  if (bounds.max !== undefined && value > bounds.max) {
    issues.push(`${key} must be <= ${bounds.max}`);
    return undefined;
  }
  return value;
}

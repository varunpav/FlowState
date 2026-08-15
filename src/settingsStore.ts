import { load } from "@tauri-apps/plugin-store";
import { initialPomodoroState, type PomodoroState } from "./core/pomodoro";
import { DEFAULT_SETTINGS, parseSettings, withDefaults, type Settings } from "./core/settings";

const STORE_PATH = "settings.json";
const POMODORO_STATE_KEY = "pomodoroState";

/**
 * Same file the Rust scheduler reads/writes reminder budgets in (under
 * remainingMsByKind/reminderConfigs) — that's the whole point of
 * plugin-store over localStorage: one file, readable from both sides.
 */
async function getStore() {
  return load(STORE_PATH, { autoSave: false });
}

export async function loadSettings(): Promise<Settings> {
  const store = await getStore();
  const raw: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = await store.get(key);
    if (value !== undefined) raw[key] = value;
  }

  // withDefaults fills anything genuinely missing (a v1-shaped flat file, or
  // a field added after this file was last written) BEFORE validation, so
  // schema growth can't silently reset every setting to defaults.
  const merged = withDefaults(raw);
  const result = parseSettings(merged);
  if (!result.ok) {
    console.warn("Invalid persisted settings, falling back to defaults:", result.issues);
    return { ...DEFAULT_SETTINGS };
  }
  return result.value;
}

export async function saveSettings(settings: Settings): Promise<void> {
  const store = await getStore();
  for (const [key, value] of Object.entries(settings)) {
    await store.set(key, value);
  }
  await store.save();
}

function isPomodoroState(value: unknown): value is PomodoroState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v["phase"] === "focus" || v["phase"] === "break") && typeof v["completedBlocks"] === "number";
}

/**
 * The Pomodoro phase/completedBlocks pair is runtime state, not a user
 * preference — it lives in the same settings.json file for one-file
 * simplicity, under its own key, so it never goes through parseSettings'
 * validation (which would reject the whole settings object over a corrupt
 * runtime field the user never edited).
 */
export async function loadPomodoroState(): Promise<PomodoroState> {
  const store = await getStore();
  const raw = await store.get(POMODORO_STATE_KEY);
  return isPomodoroState(raw) ? raw : initialPomodoroState();
}

export async function savePomodoroState(state: PomodoroState): Promise<void> {
  const store = await getStore();
  await store.set(POMODORO_STATE_KEY, state);
  await store.save();
}

import { load } from "@tauri-apps/plugin-store";
import { DEFAULT_SETTINGS, parseSettings, type Settings } from "./core/settings";

const STORE_PATH = "settings.json";

/**
 * Same file the Rust scheduler reads/writes `remainingMs` in — that's the
 * whole point of plugin-store over localStorage (see Phase 4 plan notes):
 * one file, readable from both sides.
 */
async function getStore() {
  return load(STORE_PATH, { autoSave: false });
}

export async function loadSettings(): Promise<Settings> {
  const store = await getStore();
  const raw: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = await store.get(key);
    if (value !== undefined) raw[key] = value;
  }

  const result = parseSettings(raw);
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

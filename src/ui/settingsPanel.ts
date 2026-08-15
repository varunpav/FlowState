import type { ChimeHandle } from "../audio/chime";
import { parseSettings, type Settings } from "../core/settings";
import { saveSettings } from "../settingsStore";

export interface SettingsPanelElements {
  saveBtn: HTMLButtonElement;
  testSoundBtn: HTMLButtonElement;
  errorEl: HTMLElement;
  intervalInput: HTMLInputElement;
  snoozeInput: HTMLInputElement;
  maxSnoozesInput: HTMLInputElement;
  volumeInput: HTMLInputElement;
}

export interface SettingsPanel {
  /** Repopulate fields from the current settings — call when the Settings tab becomes active. */
  refresh(): void;
}

/**
 * Mutates the shared `settings` object in place (rather than replacing it)
 * so every other holder of the same reference — takeover.ts, main.ts's
 * render loop — sees updates without needing a pub/sub layer. Single-window
 * app, no concurrency concerns.
 */
export function initSettingsPanel(
  el: SettingsPanelElements,
  settings: Settings,
  chime: ChimeHandle,
  onSaved: () => void,
): SettingsPanel {
  function refresh() {
    el.intervalInput.value = String(settings.intervalMs / 60_000);
    el.snoozeInput.value = String(settings.snoozeMs / 60_000);
    el.maxSnoozesInput.value = String(settings.maxSnoozes);
    el.volumeInput.value = String(settings.volume);
    el.errorEl.hidden = true;
  }

  el.saveBtn.addEventListener("click", () => {
    void (async () => {
      const candidate = {
        intervalMs: Number(el.intervalInput.value) * 60_000,
        snoozeMs: Number(el.snoozeInput.value) * 60_000,
        maxSnoozes: Number(el.maxSnoozesInput.value),
        volume: Number(el.volumeInput.value),
        startWithWindows: settings.startWithWindows,
      };
      const result = parseSettings(candidate);
      if (!result.ok) {
        el.errorEl.textContent = result.issues.join("; ");
        el.errorEl.hidden = false;
        return;
      }
      Object.assign(settings, result.value);
      chime.setVolume(settings.volume);
      await saveSettings(settings);
      onSaved();
    })();
  });

  el.testSoundBtn.addEventListener("click", () => {
    chime.setVolume(Number(el.volumeInput.value));
    chime.start();
    window.setTimeout(() => chime.stop(), 1200);
  });

  return { refresh };
}

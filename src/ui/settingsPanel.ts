import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import type { ChimeHandle } from "../audio/chime";
import { parseSettings, type Settings } from "../core/settings";
import { saveSettings } from "../settingsStore";
import { mountPomodoroCard, mountReminderCard } from "./reminderCard";

export interface SettingsPanelElements {
  remindersContainerEl: HTMLElement;
  saveBtn: HTMLButtonElement;
  testSoundBtn: HTMLButtonElement;
  errorEl: HTMLElement;
  bottleOzInput: HTMLInputElement;
  dailyGoalOzInput: HTMLInputElement;
  snoozeInput: HTMLInputElement;
  maxSnoozesInput: HTMLInputElement;
  volumeInput: HTMLInputElement;
  startWithWindowsInput: HTMLInputElement;
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
  onSaved: (settings: Settings) => void,
): SettingsPanel {
  const hydrationCard = mountReminderCard(el.remindersContainerEl, "hydration", settings.reminders.hydration);
  const pomodoroCard = mountPomodoroCard(el.remindersContainerEl, settings.pomodoro);
  const eyeBreakCard = mountReminderCard(el.remindersContainerEl, "eyeBreak", settings.reminders.eyeBreak);
  const standUpCard = mountReminderCard(el.remindersContainerEl, "standUp", settings.reminders.standUp);

  function refresh() {
    hydrationCard.setValue(settings.reminders.hydration);
    pomodoroCard.setValue(settings.pomodoro);
    eyeBreakCard.setValue(settings.reminders.eyeBreak);
    standUpCard.setValue(settings.reminders.standUp);
    el.bottleOzInput.value = String(settings.water.bottleOz);
    el.dailyGoalOzInput.value = String(settings.water.dailyGoalOz);
    el.snoozeInput.value = String(settings.snoozeMs / 60_000);
    el.maxSnoozesInput.value = String(settings.maxSnoozes);
    el.volumeInput.value = String(settings.volume);
    el.errorEl.hidden = true;
    // The OS registry is the source of truth, not the persisted flag — it
    // can drift if the user removes the entry via Task Manager's Startup
    // tab without ever touching this app's settings.
    void isEnabled().then((actual) => {
      el.startWithWindowsInput.checked = actual;
    });
  }

  el.saveBtn.addEventListener("click", () => {
    void (async () => {
      const candidate = {
        reminders: {
          hydration: hydrationCard.getValue(),
          eyeBreak: eyeBreakCard.getValue(),
          standUp: standUpCard.getValue(),
        },
        pomodoro: pomodoroCard.getValue(),
        water: {
          bottleOz: Number(el.bottleOzInput.value),
          dailyGoalOz: Number(el.dailyGoalOzInput.value),
        },
        snoozeMs: Number(el.snoozeInput.value) * 60_000,
        maxSnoozes: Number(el.maxSnoozesInput.value),
        volume: Number(el.volumeInput.value),
        startWithWindows: el.startWithWindowsInput.checked,
      };
      const result = parseSettings(candidate);
      if (!result.ok) {
        el.errorEl.textContent = result.issues.join("; ");
        el.errorEl.hidden = false;
        return;
      }

      if (result.value.startWithWindows) {
        await enable();
      } else {
        await disable();
      }

      Object.assign(settings, result.value);
      chime.setVolume(settings.volume);
      await saveSettings(settings);
      onSaved(settings);
    })();
  });

  el.testSoundBtn.addEventListener("click", () => {
    chime.setVolume(Number(el.volumeInput.value));
    chime.startOnce();
  });

  return { refresh };
}

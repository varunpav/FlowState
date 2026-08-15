import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import type { ChimeHandle } from "../audio/chime";
import { relativeDayLabel } from "../core/format";
import { parseSettings, type Settings } from "../core/settings";
import { addDays } from "../core/waterLog";
import { saveSettings } from "../settingsStore";
import { mountPomodoroCard, mountReminderCard } from "./reminderCard";
import { createSwitch } from "./switch";

const WATER_HISTORY_DAYS = 7;

export interface SettingsPanelElements {
  remindersContainerEl: HTMLElement;
  saveBtn: HTMLButtonElement;
  testSoundBtn: HTMLButtonElement;
  errorEl: HTMLElement;
  bottleOzInput: HTMLInputElement;
  dailyGoalOzInput: HTMLInputElement;
  waterDaySelect: HTMLSelectElement;
  waterLoggedEl: HTMLElement;
  waterAmountInput: HTMLInputElement;
  addWaterBtn: HTMLButtonElement;
  removeWaterBtn: HTMLButtonElement;
  clearDayBtn: HTMLButtonElement;
  snoozeInput: HTMLInputElement;
  maxSnoozesInput: HTMLInputElement;
  volumeInput: HTMLInputElement;
  idlePauseSwitchContainerEl: HTMLElement;
  idlePauseThresholdRowEl: HTMLElement;
  idlePauseThresholdInput: HTMLInputElement;
  startWithWindowsContainerEl: HTMLElement;
}

export interface SettingsPanel {
  /** Repopulate fields from the current settings — call when the Settings tab becomes active. */
  refresh(): void;
}

/**
 * The water log is a separate store from Settings and isn't validated by
 * parseSettings, so add/remove/clear act immediately rather than waiting on
 * the Save button — routing them through Save would mean Save silently owns
 * two unrelated stores. `getOzFor`/`getTodayKey` are live getters (not
 * snapshots) so refresh() and the post-action re-render always read current
 * state. Covers the last week only — `waterDaySelect` is populated from
 * exactly `WATER_HISTORY_DAYS` options, so there's no need for date-range
 * validation on the day itself.
 */
export interface WaterHistoryCallbacks {
  getTodayKey(): string;
  getOzFor(dayKey: string): number;
  onAddWater(dayKey: string, oz: number): void;
  onRemoveWater(dayKey: string, oz: number): void;
  onClearDay(dayKey: string): void;
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
  water: WaterHistoryCallbacks,
): SettingsPanel {
  const hydrationCard = mountReminderCard(el.remindersContainerEl, "hydration", settings.reminders.hydration);
  const pomodoroCard = mountPomodoroCard(el.remindersContainerEl, settings.pomodoro);
  const eyeBreakCard = mountReminderCard(el.remindersContainerEl, "eyeBreak", settings.reminders.eyeBreak);
  const standUpCard = mountReminderCard(el.remindersContainerEl, "standUp", settings.reminders.standUp);

  const startWithWindowsSwitch = createSwitch(false);
  el.startWithWindowsContainerEl.replaceChildren(startWithWindowsSwitch.el);

  function syncIdlePauseDisabled() {
    el.idlePauseThresholdRowEl.classList.toggle("settings-card-body-disabled", !idlePauseSwitch.get());
  }
  const idlePauseSwitch = createSwitch(true, () => syncIdlePauseDisabled());
  el.idlePauseSwitchContainerEl.replaceChildren(idlePauseSwitch.el);

  function populateWaterDaySelect() {
    const todayKey = water.getTodayKey();
    const previousSelection = el.waterDaySelect.value;
    el.waterDaySelect.replaceChildren(
      ...Array.from({ length: WATER_HISTORY_DAYS }, (_, i) => {
        const dayKey = addDays(todayKey, -i);
        const option = document.createElement("option");
        option.value = dayKey;
        option.textContent = relativeDayLabel(dayKey, todayKey);
        return option;
      }),
    );
    // Keep whatever day was selected across a refresh (e.g. after Add),
    // rather than always snapping back to today.
    el.waterDaySelect.value = previousSelection || todayKey;
  }

  function refreshWaterLogged() {
    const dayKey = el.waterDaySelect.value || water.getTodayKey();
    el.waterLoggedEl.textContent = `Logged: ${water.getOzFor(dayKey)} oz`;
  }

  function refresh() {
    hydrationCard.setValue(settings.reminders.hydration);
    pomodoroCard.setValue(settings.pomodoro);
    eyeBreakCard.setValue(settings.reminders.eyeBreak);
    standUpCard.setValue(settings.reminders.standUp);
    el.bottleOzInput.value = String(settings.water.bottleOz);
    el.dailyGoalOzInput.value = String(settings.water.dailyGoalOz);
    populateWaterDaySelect();
    refreshWaterLogged();
    el.snoozeInput.value = String(settings.snoozeMs / 60_000);
    el.maxSnoozesInput.value = String(settings.maxSnoozes);
    el.volumeInput.value = String(settings.volume);
    idlePauseSwitch.set(settings.idlePause.enabled);
    el.idlePauseThresholdInput.value = String(settings.idlePause.thresholdSeconds);
    syncIdlePauseDisabled();
    el.errorEl.hidden = true;
    // The OS registry is the source of truth, not the persisted flag — it
    // can drift if the user removes the entry via Task Manager's Startup
    // tab without ever touching this app's settings.
    void isEnabled().then((actual) => {
      startWithWindowsSwitch.set(actual);
    });
  }

  el.waterDaySelect.addEventListener("change", refreshWaterLogged);

  el.addWaterBtn.addEventListener("click", () => {
    const oz = Number(el.waterAmountInput.value);
    if (oz > 0) {
      water.onAddWater(el.waterDaySelect.value, oz);
      el.waterAmountInput.value = "";
      refreshWaterLogged();
    }
  });

  el.removeWaterBtn.addEventListener("click", () => {
    const oz = Number(el.waterAmountInput.value);
    if (oz > 0) {
      water.onRemoveWater(el.waterDaySelect.value, oz);
      el.waterAmountInput.value = "";
      refreshWaterLogged();
    }
  });

  el.clearDayBtn.addEventListener("click", () => {
    water.onClearDay(el.waterDaySelect.value);
    refreshWaterLogged();
  });

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
        idlePause: {
          enabled: idlePauseSwitch.get(),
          thresholdSeconds: Number(el.idlePauseThresholdInput.value),
        },
        snoozeMs: Number(el.snoozeInput.value) * 60_000,
        maxSnoozes: Number(el.maxSnoozesInput.value),
        volume: Number(el.volumeInput.value),
        startWithWindows: startWithWindowsSwitch.get(),
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

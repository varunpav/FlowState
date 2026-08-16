import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import type { ChimeHandle } from "../audio/chime";
import { cvSelftest } from "../cv";
import { relativeDayLabel } from "../core/format";
import { parseSettings, type Settings } from "../core/settings";
import { addDays } from "../core/waterLog";
import { saveSettings } from "../settingsStore";
import { mountPomodoroCard, mountReminderCard } from "./reminderCard";
import { createSwitch } from "./switch";

const WATER_HISTORY_DAYS = 7;
const STATUS_OK_TIMEOUT_MS = 1500;

export interface SettingsPanelElements {
  remindersContainerEl: HTMLElement;
  testSoundBtn: HTMLButtonElement;
  statusEl: HTMLElement;
  bottleOzInput: HTMLInputElement;
  dailyGoalOzInput: HTMLInputElement;
  waterDayPrevBtn: HTMLButtonElement;
  waterDayLabelEl: HTMLElement;
  waterDayNextBtn: HTMLButtonElement;
  waterAmountInput: HTMLInputElement;
  addWaterBtn: HTMLButtonElement;
  removeWaterBtn: HTMLButtonElement;
  snoozeInput: HTMLInputElement;
  maxSnoozesInput: HTMLInputElement;
  volumeInput: HTMLInputElement;
  idlePauseSwitchContainerEl: HTMLElement;
  idlePauseThresholdRowEl: HTMLElement;
  idlePauseThresholdInput: HTMLInputElement;
  cvSwitchContainerEl: HTMLElement;
  cvCheckBtn: HTMLButtonElement;
  cvCheckResultEl: HTMLElement;
  startWithWindowsContainerEl: HTMLElement;
}

export interface SettingsPanel {
  /** Repopulate fields from the current settings — call when the Settings tab becomes active. */
  refresh(): void;
}

/**
 * The water log is a separate store from Settings and isn't validated by
 * parseSettings, so add/remove act immediately rather than going through the
 * settings commit path — routing them through it would mean one function
 * silently owns two unrelated stores. `getOzFor`/`getTodayKey` are live
 * getters (not snapshots) so refresh() and the post-action re-render always
 * read current state. Covers the last week only — the day stepper is bounded
 * to exactly `WATER_HISTORY_DAYS` steps back from today, so there's no need
 * for date-range validation on the day itself.
 */
export interface WaterHistoryCallbacks {
  getTodayKey(): string;
  getOzFor(dayKey: string): number;
  onAddWater(dayKey: string, oz: number): void;
  onRemoveWater(dayKey: string, oz: number): void;
}

/**
 * Mutates the shared `settings` object in place (rather than replacing it)
 * so every other holder of the same reference — takeover.ts, main.ts's
 * render loop — sees updates without needing a pub/sub layer. Single-window
 * app, no concurrency concerns.
 *
 * There is no Save button: every field commits the moment it changes (see
 * `commit()` below). That used to route through a single Save handler which
 * called `tauri-plugin-autostart`'s `disable()` unconditionally — on a
 * machine where autostart was never enabled, `disable()` rejects (the
 * underlying registry value doesn't exist to delete), and the old handler
 * awaited that *before* persisting anything, so the whole save silently did
 * nothing. Autostart is now applied only from the switch's own handler,
 * diffed against the actual OS state first, and can never block persisting
 * the rest of the settings.
 */
export function initSettingsPanel(
  el: SettingsPanelElements,
  settings: Settings,
  chime: ChimeHandle,
  onSettingsChanged: (settings: Settings) => void,
  water: WaterHistoryCallbacks,
): SettingsPanel {
  // Guards refresh() from ever being read back as a user edit — setValue()
  // on the switches/segmented controls/inputs below doesn't fire their
  // onChange callbacks by construction, but this is cheap insurance against
  // that invariant breaking later and causing an infinite refresh<->commit loop.
  let suppress = false;
  let pending: Promise<void> = Promise.resolve();
  let statusTimeout: ReturnType<typeof setTimeout> | undefined;

  function showStatus(text: string, kind: "ok" | "error") {
    el.statusEl.textContent = text;
    el.statusEl.hidden = false;
    el.statusEl.classList.toggle("settings-status-error", kind === "error");
    el.statusEl.classList.toggle("settings-status-ok", kind === "ok");
    if (statusTimeout !== undefined) clearTimeout(statusTimeout);
    if (kind === "ok") {
      statusTimeout = setTimeout(() => {
        el.statusEl.hidden = true;
      }, STATUS_OK_TIMEOUT_MS);
    }
  }

  function buildCandidate() {
    return {
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
      cv: { enabled: cvSwitch.get() },
      snoozeMs: Number(el.snoozeInput.value) * 60_000,
      maxSnoozes: Number(el.maxSnoozesInput.value),
      volume: Number(el.volumeInput.value),
      startWithWindows: startWithWindowsSwitch.get(),
    };
  }

  async function commitNow(): Promise<void> {
    const candidate = buildCandidate();
    const result = parseSettings(candidate);
    if (!result.ok) {
      // Repaint BEFORE showing the error — refresh() unconditionally hides
      // the status line as part of resetting every field, so calling it
      // after showStatus() would immediately hide the very error it just
      // displayed.
      refresh();
      showStatus(result.issues.join("; "), "error");
      return;
    }
    Object.assign(settings, result.value);
    chime.setVolume(settings.volume);
    await saveSettings(settings);
    onSettingsChanged(settings);
    showStatus("Saved", "ok");
  }

  /**
   * Every widget change calls this. Chained through `pending` rather than
   * fired independently — two fast toggles would otherwise interleave their
   * `store.save()` writes. Each run rebuilds the candidate from live DOM
   * state at the time it actually executes, so the last one always wins.
   */
  function commit(): Promise<void> {
    if (suppress) return Promise.resolve();
    pending = pending.then(commitNow).catch((err: unknown) => {
      console.error("Failed to save settings:", err);
      showStatus("Failed to save settings", "error");
    });
    return pending;
  }

  /**
   * Applied only here, never as part of `commit()` — this is a fallible OS
   * side effect (see the module docstring) and must never be able to block
   * or discard the rest of the settings. Diffed against the actual registry
   * state first because `disable()` throws when there's nothing to remove.
   */
  async function applyAutostart(desired: boolean): Promise<void> {
    try {
      const actual = await isEnabled();
      if (desired === actual) return;
      if (desired) {
        await enable();
      } else {
        await disable();
      }
    } catch (err) {
      console.error("Failed to update Start with Windows:", err);
      const actual = await isEnabled();
      startWithWindowsSwitch.set(actual);
      // Await the corrective commit and show the failure status AFTER it —
      // commit() ends with its own showStatus("Saved", "ok") on success,
      // which would otherwise silently overwrite this error the instant it
      // appeared (the settings themselves did save; the OS-level autostart
      // change is what failed, and that's the part worth surfacing last).
      await commit();
      showStatus("Failed to update Start with Windows", "error");
    }
  }

  const hydrationCard = mountReminderCard(el.remindersContainerEl, "hydration", settings.reminders.hydration, commit);
  const pomodoroCard = mountPomodoroCard(el.remindersContainerEl, settings.pomodoro, commit);
  const eyeBreakCard = mountReminderCard(el.remindersContainerEl, "eyeBreak", settings.reminders.eyeBreak, commit);
  const standUpCard = mountReminderCard(el.remindersContainerEl, "standUp", settings.reminders.standUp, commit);

  const startWithWindowsSwitch = createSwitch(false, (value) => {
    // Persist first — the settings commit must never depend on the OS
    // registry call succeeding.
    void commit();
    void applyAutostart(value);
  });
  el.startWithWindowsContainerEl.replaceChildren(startWithWindowsSwitch.el);

  function syncIdlePauseDisabled() {
    el.idlePauseThresholdRowEl.classList.toggle("settings-card-body-disabled", !idlePauseSwitch.get());
  }
  const idlePauseSwitch = createSwitch(true, () => {
    syncIdlePauseDisabled();
    void commit();
  });
  el.idlePauseSwitchContainerEl.replaceChildren(idlePauseSwitch.el);

  const cvSwitch = createSwitch(false, () => void commit());
  el.cvSwitchContainerEl.replaceChildren(cvSwitch.el);

  // Stepped by the last week only — `addDays` on `dayKeyOf`'s pure-UTC day
  // keys, never a local-timezone Date, so this can't drift a day off near a
  // timezone boundary. Reset to today whenever the tab is (re)opened rather
  // than persisted, so the editor doesn't silently reopen on a stale day.
  let selectedDayKey = water.getTodayKey();

  function oldestSelectableDayKey(): string {
    return addDays(water.getTodayKey(), -(WATER_HISTORY_DAYS - 1));
  }

  function renderWaterDayStepper() {
    const todayKey = water.getTodayKey();
    el.waterDayLabelEl.textContent = `${relativeDayLabel(selectedDayKey, todayKey)} · ${water.getOzFor(selectedDayKey)} oz`;
    el.waterDayPrevBtn.disabled = selectedDayKey <= oldestSelectableDayKey();
    el.waterDayNextBtn.disabled = selectedDayKey >= todayKey;
  }

  function refresh() {
    suppress = true;
    hydrationCard.setValue(settings.reminders.hydration);
    pomodoroCard.setValue(settings.pomodoro);
    eyeBreakCard.setValue(settings.reminders.eyeBreak);
    standUpCard.setValue(settings.reminders.standUp);
    el.bottleOzInput.value = String(settings.water.bottleOz);
    el.dailyGoalOzInput.value = String(settings.water.dailyGoalOz);
    selectedDayKey = water.getTodayKey();
    renderWaterDayStepper();
    el.snoozeInput.value = String(settings.snoozeMs / 60_000);
    el.maxSnoozesInput.value = String(settings.maxSnoozes);
    el.volumeInput.value = String(settings.volume);
    idlePauseSwitch.set(settings.idlePause.enabled);
    el.idlePauseThresholdInput.value = String(settings.idlePause.thresholdSeconds);
    syncIdlePauseDisabled();
    cvSwitch.set(settings.cv.enabled);
    el.cvCheckResultEl.hidden = true;
    el.statusEl.hidden = true;
    // The OS registry is the source of truth, not the persisted flag — it
    // can drift if the user removes the entry via Task Manager's Startup
    // tab without ever touching this app's settings.
    void isEnabled().then((actual) => {
      startWithWindowsSwitch.set(actual);
    });
    suppress = false;
  }

  el.waterDayPrevBtn.addEventListener("click", () => {
    const candidate = addDays(selectedDayKey, -1);
    if (candidate < oldestSelectableDayKey()) return;
    selectedDayKey = candidate;
    renderWaterDayStepper();
  });

  el.waterDayNextBtn.addEventListener("click", () => {
    const candidate = addDays(selectedDayKey, 1);
    if (candidate > water.getTodayKey()) return;
    selectedDayKey = candidate;
    renderWaterDayStepper();
  });

  el.addWaterBtn.addEventListener("click", () => {
    const oz = Number(el.waterAmountInput.value);
    if (oz > 0) {
      water.onAddWater(selectedDayKey, oz);
      el.waterAmountInput.value = "";
      renderWaterDayStepper();
    }
  });

  el.removeWaterBtn.addEventListener("click", () => {
    const oz = Number(el.waterAmountInput.value);
    if (oz > 0) {
      water.onRemoveWater(selectedDayKey, oz);
      el.waterAmountInput.value = "";
      renderWaterDayStepper();
    }
  });

  // change, not input — committing per keystroke would write "2" on the way
  // to "20", fail validation mid-typing, and thrash the store.
  el.bottleOzInput.addEventListener("change", () => void commit());
  el.dailyGoalOzInput.addEventListener("change", () => void commit());
  el.snoozeInput.addEventListener("change", () => void commit());
  el.maxSnoozesInput.addEventListener("change", () => void commit());
  el.idlePauseThresholdInput.addEventListener("change", () => void commit());

  // Live audible feedback while dragging, without committing per pixel.
  el.volumeInput.addEventListener("input", () => chime.setVolume(Number(el.volumeInput.value)));
  el.volumeInput.addEventListener("change", () => void commit());

  el.testSoundBtn.addEventListener("click", () => {
    chime.setVolume(Number(el.volumeInput.value));
    chime.startOnce();
  });

  // Doubles as the setup diagnostic (cv/README.md) and the "permissions
  // check" surface — python-not-installed, opencv-missing, model-files-
  // missing, and camera-unavailable are otherwise indistinguishable to a
  // user as "the camera pane didn't show up."
  el.cvCheckBtn.addEventListener("click", () => {
    void (async () => {
      el.cvCheckBtn.disabled = true;
      el.cvCheckResultEl.hidden = false;
      el.cvCheckResultEl.classList.remove("settings-status-error", "settings-status-ok");
      el.cvCheckResultEl.textContent = "Checking…";
      try {
        const result = await cvSelftest();
        const ok = result.opencv && result.model && result.camera;
        el.cvCheckResultEl.textContent = result.message;
        el.cvCheckResultEl.classList.toggle("settings-status-error", !ok);
        el.cvCheckResultEl.classList.toggle("settings-status-ok", ok);
      } catch (err) {
        // cv_selftest itself failing to spawn (Python isn't on PATH at all)
        // is a rejected promise, not a `{opencv:false,...}` result — the
        // camera light can never come on without a process, but this case
        // still needs its own message rather than looking like a hang.
        el.cvCheckResultEl.textContent = `Couldn't run the camera check: ${err instanceof Error ? err.message : String(err)}`;
        el.cvCheckResultEl.classList.add("settings-status-error");
      } finally {
        el.cvCheckBtn.disabled = false;
      }
    })();
  });

  return { refresh };
}

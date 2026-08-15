import type { ChimeHandle } from "../audio/chime";
import { applySnooze, resetSnoozeState, type SnoozeState } from "../core/snooze";
import type { Settings } from "../core/settings";
import { releaseTakeover, setRemainingMs } from "../ipc";

export interface TakeoverElements {
  overlayEl: HTMLElement;
  confirmBtn: HTMLButtonElement;
  snoozeBtn: HTMLButtonElement;
  snoozeHintEl: HTMLElement;
}

export interface Takeover {
  show(): void;
}

export function initTakeover(el: TakeoverElements, settings: Settings, chime: ChimeHandle): Takeover {
  let snoozeState: SnoozeState = resetSnoozeState();

  function syncSnoozeAvailability() {
    const exhausted = snoozeState.snoozeCount >= settings.maxSnoozes;
    el.snoozeBtn.disabled = exhausted;
    el.snoozeHintEl.hidden = !exhausted;
    if (exhausted) el.snoozeHintEl.textContent = "No snoozes left — please confirm.";
  }

  function hide() {
    chime.stop();
    el.overlayEl.hidden = true;
  }

  el.confirmBtn.addEventListener("click", () => {
    void (async () => {
      await releaseTakeover();
      snoozeState = resetSnoozeState();
      // TODO(phase 5): streak.updateLog(...) once persistence exists.
      await setRemainingMs(settings.intervalMs);
      hide();
    })();
  });

  el.snoozeBtn.addEventListener("click", () => {
    void (async () => {
      const result = applySnooze(snoozeState, Date.now(), {
        snoozeMs: settings.snoozeMs,
        maxSnoozes: settings.maxSnoozes,
      });
      if (!result.ok) {
        syncSnoozeAvailability();
        return;
      }
      snoozeState = result.state;
      await releaseTakeover();
      await setRemainingMs(settings.snoozeMs);
      hide();
    })();
  });

  return {
    show() {
      syncSnoozeAvailability();
      el.overlayEl.hidden = false;
      chime.start();
    },
  };
}

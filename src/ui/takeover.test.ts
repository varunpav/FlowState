// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChimeHandle } from "../audio/chime";
import { DEFAULT_SETTINGS, type Settings } from "../core/settings";
import { initTakeover, type TakeoverCallbacks, type TakeoverElements } from "./takeover";

// Hoisted so the vi.mock factories below (which are lifted above every
// top-level const) can close over it without hitting a TDZ error.
const { cvHandlers } = vi.hoisted(() => ({
  cvHandlers: {} as {
    ready?: () => void;
    frame?: (payload: { jpeg: string }) => void;
    verified?: (payload: { confidence: number }) => void;
    error?: (payload: { code: string; message: string }) => void;
  },
}));

vi.mock("../ipc", () => ({
  releaseTakeover: vi.fn().mockResolvedValue(undefined),
  setRemainingMs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../cv", () => ({
  cvStart: vi.fn().mockResolvedValue(undefined),
  cvStop: vi.fn().mockResolvedValue(undefined),
  onCvReady: vi.fn((cb: () => void) => {
    cvHandlers.ready = cb;
    return Promise.resolve(() => {});
  }),
  onCvFrame: vi.fn((cb: (p: { jpeg: string }) => void) => {
    cvHandlers.frame = cb;
    return Promise.resolve(() => {});
  }),
  onCvVerified: vi.fn((cb: (p: { confidence: number }) => void) => {
    cvHandlers.verified = cb;
    return Promise.resolve(() => {});
  }),
  onCvError: vi.fn((cb: (p: { code: string; message: string }) => void) => {
    cvHandlers.error = cb;
    return Promise.resolve(() => {});
  }),
}));

import { cvStart, cvStop } from "../cv";
import { releaseTakeover, setRemainingMs } from "../ipc";

function buildElements(): TakeoverElements {
  return {
    overlayEl: document.createElement("div"),
    titleEl: document.createElement("h2"),
    cvPaneEl: document.createElement("div"),
    cvFrameEl: document.createElement("img"),
    cvPromptEl: document.createElement("p"),
    waterEntryContainerEl: document.createElement("div"),
    confirmRowEl: document.createElement("div"),
    confirmBtn: document.createElement("button"),
    breakChoiceRowEl: document.createElement("div"),
    shortBreakBtn: document.createElement("button"),
    longBreakBtn: document.createElement("button"),
    skipRowEl: document.createElement("div"),
    skipBtn: document.createElement("button"),
    snoozeBtn: document.createElement("button"),
    snoozeHintEl: document.createElement("p"),
    turnOffRowEl: document.createElement("div"),
    turnOffBtn: document.createElement("button"),
    // DEBUG — debugSnoozeRowEl/debugSnoozeBtn commented out along with
    // TakeoverElements' matching fields; un-comment together.
    // debugSnoozeRowEl: document.createElement("div"),
    // debugSnoozeBtn: document.createElement("button"),
  };
}

/**
 * Every mounted takeover, so afterEach can close any left showing. A live
 * takeover holds a `document`-level keydown listener that only `hide()`
 * removes, and happy-dom shares one document across a file — without this,
 * one test's still-open overlay reacts to the next test's Escape.
 */
const mounted: TakeoverElements[] = [];

function fixture(overrides: (settings: Settings) => void = () => {}) {
  const el = buildElements();
  mounted.push(el);
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  overrides(settings);
  const chime: ChimeHandle = {
    start: vi.fn(),
    stop: vi.fn(),
    startOnce: vi.fn(),
    setVolume: vi.fn(),
    unlock: vi.fn(),
  } as unknown as ChimeHandle;
  const callbacks: TakeoverCallbacks = {
    onWaterLogged: vi.fn(),
    getPomodoroPhaseJustEnded: vi.fn(() => "break" as const),
    onTurnOffReminder: vi.fn().mockResolvedValue(undefined),
  };
  const takeover = initTakeover(el, settings, chime, callbacks);
  return { el, settings, chime, callbacks, takeover };
}

/** Drains the internal async chains (confirm/snooze/startCv all `void` an async IIFE). */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The water-entry widget is rebuilt on every hydration show(); its first button is the bottle-size quick-add. */
function firstQuickAddBtn(el: TakeoverElements): HTMLButtonElement {
  return el.waterEntryContainerEl.querySelector<HTMLButtonElement>("button")!;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete cvHandlers.ready;
  delete cvHandlers.frame;
  delete cvHandlers.verified;
  delete cvHandlers.error;
});

afterEach(async () => {
  // Force-close anything a test left open, via the same confirm() path a
  // real user would use — there's no exposed hide(). A no-op on a fixture
  // that never called show() (confirm() early-returns with no activeKind)
  // or one that already closed itself.
  for (const el of mounted) el.confirmBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  mounted.length = 0;
});

describe("initTakeover — dismissing", () => {
  it("logs water and closes when a quick-add amount is submitted", async () => {
    const { el, callbacks, takeover } = fixture();
    takeover.show("hydration");

    // Compose an amount, then commit it — the quick-add buttons only build up
    // the field; "Add" is what actually logs (see waterEntry.ts).
    const buttons = el.waterEntryContainerEl.querySelectorAll<HTMLButtonElement>("button");
    buttons[0]?.click(); // +bottleOz into the field
    const addBtn = Array.from(buttons).find((b) => b.textContent === "Add")!;
    addBtn.click();
    await flush();

    expect(callbacks.onWaterLogged).toHaveBeenCalledTimes(1);
    expect(callbacks.onWaterLogged).toHaveBeenCalledWith(DEFAULT_SETTINGS.water.bottleOz, expect.any(Number));
    expect(el.overlayEl.hidden).toBe(true);
  });

  it("Done is visible on every hydration takeover, even without camera verification, and closes without logging water", async () => {
    const { el, callbacks, takeover } = fixture((s) => {
      s.cv.enabled = false;
    });
    takeover.show("hydration");

    expect(el.skipRowEl.hidden).toBe(false);

    el.skipBtn.click();
    await flush();

    expect(callbacks.onWaterLogged).not.toHaveBeenCalled();
    expect(releaseTakeover).toHaveBeenCalledTimes(1);
    expect(el.overlayEl.hidden).toBe(true);
  });

  it("Done stays hidden for non-hydration kinds", () => {
    const { el, takeover } = fixture();
    takeover.show("eyeBreak");
    expect(el.skipRowEl.hidden).toBe(true);
  });

  it("a non-hydration takeover confirms through the single Done button", async () => {
    const { el, takeover } = fixture();
    takeover.show("eyeBreak");

    expect(el.confirmRowEl.hidden).toBe(false);
    expect(el.waterEntryContainerEl.hidden).toBe(true);

    el.confirmBtn.click();
    await flush();

    expect(releaseTakeover).toHaveBeenCalledTimes(1);
    expect(el.overlayEl.hidden).toBe(true);
  });
});

describe("initTakeover — snooze", () => {
  it("arms only the snooze length, not the full interval", async () => {
    const { el, settings, takeover } = fixture((s) => {
      s.snoozeMs = 5 * 60_000;
    });
    takeover.show("hydration");

    el.snoozeBtn.click();
    await flush();

    expect(setRemainingMs).toHaveBeenCalledWith("hydration", settings.snoozeMs);
    expect(el.overlayEl.hidden).toBe(true);
  });

  it("disables snooze and explains why once a kind exhausts its allowance", async () => {
    const { el, takeover } = fixture((s) => {
      s.maxSnoozes = 1;
    });

    takeover.show("hydration");
    el.snoozeBtn.click();
    await flush();

    takeover.show("hydration");
    expect(el.snoozeBtn.disabled).toBe(true);
    expect(el.snoozeHintEl.hidden).toBe(false);
    expect(el.snoozeHintEl.textContent).toBe("No snoozes left — please confirm.");
  });

  it("gives each reminder kind its own snooze budget rather than one shared pool", async () => {
    const { el, takeover } = fixture((s) => {
      s.maxSnoozes = 1;
    });

    // Exhaust hydration's single snooze.
    takeover.show("hydration");
    el.snoozeBtn.click();
    await flush();

    takeover.show("hydration");
    expect(el.snoozeBtn.disabled).toBe(true);

    // Pomodoro has never been snoozed — a shared counter would wrongly report
    // it as exhausted too, which is exactly the bug this guards.
    takeover.show("pomodoro");
    expect(el.snoozeBtn.disabled).toBe(false);
    expect(el.snoozeHintEl.hidden).toBe(true);
  });

  it("restores a kind's full allowance after it is properly confirmed", async () => {
    const { el, takeover } = fixture((s) => {
      s.maxSnoozes = 1;
    });

    takeover.show("eyeBreak");
    el.snoozeBtn.click();
    await flush();

    takeover.show("eyeBreak");
    expect(el.snoozeBtn.disabled).toBe(true);

    el.confirmBtn.click(); // a real confirm resets that kind's counter
    await flush();

    takeover.show("eyeBreak");
    expect(el.snoozeBtn.disabled).toBe(false);
  });

  it("Escape snoozes, but does nothing once snoozes are exhausted", async () => {
    const { el, takeover } = fixture((s) => {
      s.maxSnoozes = 1;
    });
    takeover.show("hydration");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flush();
    expect(setRemainingMs).toHaveBeenCalledTimes(1);
    expect(el.overlayEl.hidden).toBe(true);

    takeover.show("hydration"); // snooze now exhausted for hydration
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flush();
    expect(setRemainingMs).toHaveBeenCalledTimes(1); // unchanged — Escape was inert
    expect(el.overlayEl.hidden).toBe(false); // still up, awaiting a real confirm
  });

  // DEBUG — commented out along with takeover.ts's debugSnoozeBtn wiring;
  // un-comment together (also needs buildElements()'s debugSnoozeRowEl/
  // debugSnoozeBtn re-added above).
  /*
  it("DEBUG: the 5s snooze shortcut only ever shows for hydration", () => {
    const { el, takeover } = fixture();

    takeover.show("hydration");
    expect(el.debugSnoozeRowEl.hidden).toBe(false);

    takeover.show("eyeBreak");
    expect(el.debugSnoozeRowEl.hidden).toBe(true);
  });

  it("DEBUG: clicking the 5s snooze shortcut arms a 5s budget, closes, and counts as a real snooze", async () => {
    const { el, takeover } = fixture((s) => {
      s.maxSnoozes = 1;
    });
    takeover.show("hydration");

    el.debugSnoozeBtn.click();
    await flush();

    expect(setRemainingMs).toHaveBeenCalledWith("hydration", 5_000);
    expect(releaseTakeover).toHaveBeenCalledTimes(1);
    expect(el.overlayEl.hidden).toBe(true);

    takeover.show("hydration");
    // It's a real snooze under the hood, just shorter — so it counts toward
    // maxSnoozes (here already exhausted after one use)...
    expect(el.snoozeBtn.disabled).toBe(true);
    // ...and correctly reveals hydration's Turn off, the whole reason this
    // needs to share doSnooze with the real button rather than bypass it.
    expect(el.turnOffRowEl.hidden).toBe(false);
  });
  */
});

describe("initTakeover — turn off", () => {
  it("offers Turn off immediately for pomodoro, eye break, and stand up", () => {
    const { el, takeover } = fixture();

    for (const kind of ["pomodoro", "eyeBreak", "standUp"] as const) {
      takeover.show(kind);
      expect(el.turnOffRowEl.hidden).toBe(false);
    }
  });

  it("hides Turn off for hydration until it has been snoozed once, then offers it on the next takeover", async () => {
    const { el, takeover } = fixture();

    takeover.show("hydration");
    expect(el.turnOffRowEl.hidden).toBe(true);

    el.snoozeBtn.click();
    await flush();

    takeover.show("hydration");
    expect(el.turnOffRowEl.hidden).toBe(false);
  });

  it("a real confirm resets hydration's snooze count, hiding Turn off again on the next takeover", async () => {
    const { el, takeover } = fixture();

    takeover.show("hydration");
    el.snoozeBtn.click();
    await flush();

    takeover.show("hydration");
    expect(el.turnOffRowEl.hidden).toBe(false);

    // Skip shares confirm()'s exact release/reset/hide mechanics — hydration
    // has no confirmBtn of its own to click (that row stays hidden for it).
    el.skipBtn.click();
    await flush();

    takeover.show("hydration");
    expect(el.turnOffRowEl.hidden).toBe(true);
  });

  it("clicking Turn off disables the reminder via the callback, then releases and hides", async () => {
    const { el, callbacks, takeover } = fixture();
    takeover.show("eyeBreak");

    el.turnOffBtn.click();
    await flush();

    expect(callbacks.onTurnOffReminder).toHaveBeenCalledWith("eyeBreak");
    expect(releaseTakeover).toHaveBeenCalledTimes(1);
    expect(el.overlayEl.hidden).toBe(true);
  });

  it("disables the reminder before releasing the takeover, not after", async () => {
    // Rust's decrement loop is gated on `active` still being set — if
    // release ran first, the just-disabled kind's cleared budget could get
    // clobbered by a tick landing in between.
    const order: string[] = [];
    const { el, callbacks, takeover } = fixture();
    vi.mocked(callbacks.onTurnOffReminder).mockImplementation(async () => {
      order.push("turnOff");
    });
    vi.mocked(releaseTakeover).mockImplementation(async () => {
      order.push("release");
    });
    takeover.show("standUp");

    el.turnOffBtn.click();
    await flush();

    expect(order).toEqual(["turnOff", "release"]);
  });
});

describe("initTakeover — pomodoro break choice", () => {
  it("a focus-end takeover shows short/long break buttons labeled with the configured durations, not the single confirm", () => {
    const { el, callbacks, takeover } = fixture((s) => {
      s.pomodoro.breakMs = 5 * 60_000;
      s.pomodoro.longBreakMs = 15 * 60_000;
    });
    vi.mocked(callbacks.getPomodoroPhaseJustEnded).mockReturnValue("focus");

    takeover.show("pomodoro");

    expect(el.breakChoiceRowEl.hidden).toBe(false);
    expect(el.confirmRowEl.hidden).toBe(true);
    expect(el.shortBreakBtn.textContent).toBe("Short break · 5 min");
    expect(el.longBreakBtn.textContent).toBe("Long break · 15 min");
  });

  it("a break-end takeover still shows the single confirm button, not the break choice", () => {
    const { el, callbacks, takeover } = fixture();
    vi.mocked(callbacks.getPomodoroPhaseJustEnded).mockReturnValue("break");

    takeover.show("pomodoro");

    expect(el.breakChoiceRowEl.hidden).toBe(true);
    expect(el.confirmRowEl.hidden).toBe(false);
    expect(el.confirmBtn.textContent).toBe("Back to focus");
  });

  it("Short break overwrites the pre-armed budget with the short break length and closes", async () => {
    const { el, callbacks, takeover } = fixture((s) => {
      s.pomodoro.breakMs = 5 * 60_000;
    });
    vi.mocked(callbacks.getPomodoroPhaseJustEnded).mockReturnValue("focus");
    takeover.show("pomodoro");

    el.shortBreakBtn.click();
    await flush();

    expect(setRemainingMs).toHaveBeenCalledWith("pomodoro", 5 * 60_000);
    expect(releaseTakeover).toHaveBeenCalledTimes(1);
    expect(el.overlayEl.hidden).toBe(true);
  });

  it("Long break overwrites the pre-armed budget with the long break length and closes", async () => {
    const { el, callbacks, takeover } = fixture((s) => {
      s.pomodoro.longBreakMs = 15 * 60_000;
    });
    vi.mocked(callbacks.getPomodoroPhaseJustEnded).mockReturnValue("focus");
    takeover.show("pomodoro");

    el.longBreakBtn.click();
    await flush();

    expect(setRemainingMs).toHaveBeenCalledWith("pomodoro", 15 * 60_000);
    expect(releaseTakeover).toHaveBeenCalledTimes(1);
    expect(el.overlayEl.hidden).toBe(true);
  });

  it("the break-choice row never leaks into a different kind's takeover", () => {
    const { el, callbacks, takeover } = fixture();
    vi.mocked(callbacks.getPomodoroPhaseJustEnded).mockReturnValue("focus");
    takeover.show("pomodoro");
    expect(el.breakChoiceRowEl.hidden).toBe(false);

    takeover.show("eyeBreak");
    expect(el.breakChoiceRowEl.hidden).toBe(true);
    expect(el.confirmRowEl.hidden).toBe(false);
  });
});

describe("initTakeover — camera verification", () => {
  it("hides the camera pane when verification is off, but Done stays visible", () => {
    const { el, takeover } = fixture((s) => {
      s.cv.enabled = false;
    });
    takeover.show("hydration");

    expect(el.cvPaneEl.hidden).toBe(true);
    expect(el.skipRowEl.hidden).toBe(false);
    expect(el.waterEntryContainerEl.hidden).toBe(false);
    expect(cvStart).not.toHaveBeenCalled();
  });

  it("keeps Done available (alongside the now-locked water entry) while the camera watches", async () => {
    const { el, takeover } = fixture((s) => {
      s.cv.enabled = true;
    });
    takeover.show("hydration");
    await flush();

    cvHandlers.ready?.();

    expect(cvStart).toHaveBeenCalled();
    expect(el.cvPaneEl.hidden).toBe(false);
    expect(el.skipRowEl.hidden).toBe(false);
    // Hidden rather than merely disabled — a greyed-out Add beside an active
    // Done read as a second, redundant dismiss action.
    expect(el.waterEntryContainerEl.hidden).toBe(true);
  });

  it("unlocks water entry and marks the prompt verified once a sip is detected", async () => {
    const { el, takeover } = fixture((s) => {
      s.cv.enabled = true;
    });
    takeover.show("hydration");
    await flush();

    cvHandlers.verified?.({ confidence: 0.9 });

    expect(el.waterEntryContainerEl.hidden).toBe(false);
    expect(el.cvPromptEl.classList.contains("cv-verified")).toBe(true);
    expect(firstQuickAddBtn(el).disabled).toBe(false);
  });

  it("fails open — a broken camera must never trap the user out of logging water", async () => {
    const { el, takeover } = fixture((s) => {
      s.cv.enabled = true;
    });
    takeover.show("hydration");
    await flush();

    cvHandlers.error?.({ code: "no_camera", message: "No camera could be opened (index 0)." });

    expect(el.waterEntryContainerEl.hidden).toBe(false);
    expect(firstQuickAddBtn(el).disabled).toBe(false);
  });

  it("renders an incoming frame into the preview image", async () => {
    const { el, takeover } = fixture((s) => {
      s.cv.enabled = true;
    });
    takeover.show("hydration");
    await flush();

    cvHandlers.frame?.({ jpeg: "AAAA" });

    expect(el.cvFrameEl.src).toContain("data:image/jpeg;base64,AAAA");
  });

  it("stops the camera when the takeover closes, so the light always goes out", async () => {
    const { el, takeover } = fixture((s) => {
      s.cv.enabled = true;
    });
    takeover.show("hydration");
    await flush();

    el.skipBtn.click();
    await flush();

    expect(cvStop).toHaveBeenCalled();
    expect(el.cvPaneEl.hidden).toBe(true);
  });
});

describe("initTakeover — camera pre-warm", () => {
  it("does nothing when verification is switched off", () => {
    const { takeover } = fixture((s) => {
      s.cv.enabled = false;
    });
    takeover.prewarmCv();
    expect(cvStart).not.toHaveBeenCalled();
  });

  it("starts the camera ahead of the takeover, then reuses it rather than spawning twice", async () => {
    const { takeover } = fixture((s) => {
      s.cv.enabled = true;
    });

    takeover.prewarmCv();
    await flush();
    expect(cvStart).toHaveBeenCalledTimes(1);

    takeover.show("hydration"); // the real takeover arrives — must reuse the warm camera
    await flush();
    expect(cvStart).toHaveBeenCalledTimes(1);
  });

  it("cancels a pre-warm that never became a takeover", async () => {
    const { takeover } = fixture((s) => {
      s.cv.enabled = true;
    });

    takeover.prewarmCv();
    await flush();
    takeover.cancelCvPrewarm();

    expect(cvStop).toHaveBeenCalled();
  });

  it("never cancels while a takeover is actually on screen", async () => {
    const { takeover } = fixture((s) => {
      s.cv.enabled = true;
    });
    takeover.show("hydration");
    await flush();
    vi.mocked(cvStop).mockClear();

    takeover.cancelCvPrewarm();

    expect(cvStop).not.toHaveBeenCalled();
  });
});

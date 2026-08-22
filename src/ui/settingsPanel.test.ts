// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChime, type ChimeHandle } from "../audio/chime";
import { DEFAULT_SETTINGS, type Settings } from "../core/settings";
import { initSettingsPanel, type SettingsPanelElements, type WaterHistoryCallbacks } from "./settingsPanel";

vi.mock("../settingsStore", () => ({ saveSettings: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: vi.fn().mockResolvedValue(false),
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../audio/chime", () => ({
  createChime: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), startOnce: vi.fn(), setVolume: vi.fn(), unlock: vi.fn() })),
}));
vi.mock("../cv", () => ({ cvSelftest: vi.fn() }));

import { disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { cvSelftest } from "../cv";
import { saveSettings } from "../settingsStore";

/** Real DOM elements, not queried from index.html — initSettingsPanel takes an explicit elements bag, so a fixture just builds one directly. */
function buildElements(): SettingsPanelElements {
  const input = (type: string) => {
    const el = document.createElement("input");
    el.type = type;
    return el;
  };
  return {
    remindersContainerEl: document.createElement("div"),
    testSoundBtn: document.createElement("button"),
    statusEl: document.createElement("p"),
    bottleOzInput: input("number"),
    dailyGoalOzInput: input("number"),
    waterDayPrevBtn: document.createElement("button"),
    waterDayLabelEl: document.createElement("span"),
    waterDayNextBtn: document.createElement("button"),
    waterAmountInput: input("number"),
    addWaterBtn: document.createElement("button"),
    removeWaterBtn: document.createElement("button"),
    snoozeInput: input("number"),
    maxSnoozesInput: input("number"),
    volumeInput: input("range"),
    idlePauseSwitchContainerEl: document.createElement("div"),
    idlePauseThresholdRowEl: document.createElement("div"),
    idlePauseThresholdInput: input("number"),
    startWithWindowsContainerEl: document.createElement("div"),
  };
}

/**
 * The CV switch/Check-camera button/result live on the hydration card
 * itself (settingsPanel.ts appends them into `hydrationCard.bodyEl`), not
 * as separate elements passed into `SettingsPanelElements` — so tests find
 * them the same way a user would, by what they say, not by a dedicated id.
 */
function findCvControls(el: SettingsPanelElements) {
  const switchLabel = Array.from(el.remindersContainerEl.querySelectorAll("label")).find((l) =>
    l.textContent?.includes("Camera verification"),
  )!;
  const switchBtn = switchLabel.querySelector<HTMLButtonElement>("button")!;
  const group = switchLabel.parentElement!;
  const checkBtn = Array.from(group.querySelectorAll("button")).find((b) => b.textContent === "Check camera")!;
  const resultEl = group.querySelector<HTMLParagraphElement>("p.settings-status")!;
  return { switchBtn, checkBtn, resultEl, groupEl: group };
}

function fixture() {
  const el = buildElements();
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  const chime = createChime(0.7) as unknown as ChimeHandle;
  const onSettingsChanged = vi.fn();
  const water: WaterHistoryCallbacks = {
    getTodayKey: () => "2026-01-15",
    getOzFor: vi.fn(() => 0),
    onAddWater: vi.fn(),
    onRemoveWater: vi.fn(),
  };
  const panel = initSettingsPanel(el, settings, chime, onSettingsChanged, water);
  // Mirrors real usage — main.ts calls refresh() when the Settings tab
  // becomes active, before any user edit — so every plain number field
  // starts populated rather than empty-string (which `buildCandidate()`
  // would read as 0 and fail validation on the very first edit).
  panel.refresh();
  return { el, settings, chime, onSettingsChanged, water, panel };
}

function fireChange(el: HTMLElement) {
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Waits for the settingsPanel's internal `pending` commit chain to flush —
 * commit() is async and its promise isn't exposed through the public
 * `SettingsPanel` interface. A macrotask boundary (rather than counting
 * microtask ticks) drains any depth of internal `.then()`/`await` chaining.
 */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// `saveSettings(settings)` is called with the SAME mutable object every
// time (settingsPanel.ts intentionally mutates in place — see its module
// docstring), and that object gets mutated again by later commits within a
// single test. Inspecting `saveSettings.mock.calls` after the fact would
// therefore reflect the object's FINAL state for every recorded call, not
// what it was at call time — so the mock snapshots a deep clone instead.
let savedSnapshots: Settings[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  savedSnapshots = [];
  vi.mocked(saveSettings).mockImplementation(async (s) => {
    savedSnapshots.push(structuredClone(s));
  });
  vi.mocked(isEnabled).mockResolvedValue(false);
});

describe("initSettingsPanel — commit on change", () => {
  it("saves and reports the change when a plain number field is edited", async () => {
    const { el, onSettingsChanged } = fixture();
    el.bottleOzInput.value = "40";
    fireChange(el.bottleOzInput);
    await flush();

    expect(savedSnapshots).toHaveLength(1);
    expect(savedSnapshots[0]?.water.bottleOz).toBe(40);
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
  });

  it("shows an error and reverts the field instead of saving an invalid value", async () => {
    const { el, settings, onSettingsChanged } = fixture();
    const originalBottleOz = settings.water.bottleOz;

    el.bottleOzInput.value = "0"; // below the min:1 bound
    fireChange(el.bottleOzInput);
    await flush();

    expect(savedSnapshots).toHaveLength(0);
    expect(onSettingsChanged).not.toHaveBeenCalled();
    expect(el.statusEl.hidden).toBe(false);
    expect(el.statusEl.classList.contains("settings-status-error")).toBe(true);
    // refresh() repaints from the last-good settings, so the bad input reverts rather than sticking.
    expect(el.bottleOzInput.value).toBe(String(originalBottleOz));
  });
});

describe("initSettingsPanel — Start with Windows autostart", () => {
  it("persists the settings save even when disable() rejects (the v2.3 regression)", async () => {
    vi.mocked(isEnabled).mockResolvedValue(true); // currently enabled, about to be turned off
    vi.mocked(disable).mockRejectedValueOnce(new Error("registry value not found"));

    const { el, onSettingsChanged } = fixture();
    // fixture()'s refresh() kicked off an async isEnabled() -> switch.set(true)
    // that hasn't resolved yet — wait for it, or the click below flips the
    // switch's still-default `false` to `true` instead of `true` to `false`.
    await flush();
    const switchEl = el.startWithWindowsContainerEl.querySelector<HTMLButtonElement>("button")!;
    switchEl.click(); // flips true -> false in the widget, independent of the mocked isEnabled() above
    await flush();

    // The FIRST commit (from the click itself, before disable() even runs)
    // is the one that must survive disable() rejecting — a corrective
    // second commit happens afterward (applyAutostart's catch resets the
    // switch to match reality and re-commits), which is expected but not
    // what this test is verifying.
    expect(savedSnapshots[0]?.startWithWindows).toBe(false);
    expect(onSettingsChanged).toHaveBeenCalled();
    expect(el.statusEl.textContent).toBe("Failed to update Start with Windows");
  });
});

describe("initSettingsPanel — water day stepper", () => {
  it("disables Next at today and Prev six days back, refreshed on panel.refresh()", () => {
    const { el, panel } = fixture();
    panel.refresh();

    expect(el.waterDayNextBtn.disabled).toBe(true); // starts on today
    expect(el.waterDayPrevBtn.disabled).toBe(false);

    for (let i = 0; i < 6; i++) el.waterDayPrevBtn.click();

    expect(el.waterDayPrevBtn.disabled).toBe(true); // six days back is the oldest selectable day
    expect(el.waterDayNextBtn.disabled).toBe(false);

    el.waterDayPrevBtn.click(); // one step past the boundary must be a no-op
    expect(el.waterDayLabelEl.textContent).toContain("Jan 9");
  });
});

describe("initSettingsPanel — camera verification", () => {
  it("commits cv.enabled when the switch is toggled, off by default", async () => {
    const { el } = fixture();
    const { switchBtn } = findCvControls(el);
    switchBtn.click(); // default is off (DEFAULT_SETTINGS.cv.enabled === false) — this flips it on
    await flush();

    expect(savedSnapshots).toHaveLength(1);
    expect(savedSnapshots[0]?.cv.enabled).toBe(true);
  });

  it("lives on the hydration card, dimmed when Notification is selected instead of Full screen", () => {
    const { el } = fixture();
    const { groupEl } = findCvControls(el);
    expect(groupEl.classList.contains("settings-card-body-disabled")).toBe(false); // hydration defaults to "takeover"

    const notificationBtn = Array.from(el.remindersContainerEl.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "Notification",
    )!;
    notificationBtn.click();

    expect(groupEl.classList.contains("settings-card-body-disabled")).toBe(true);
  });

  it("names specifically what's missing when Check camera runs", async () => {
    vi.mocked(cvSelftest).mockResolvedValue({
      opencv: true,
      model: true,
      camera: false,
      message: "No camera could be opened (index 0).",
    });
    const { el } = fixture();
    const { checkBtn, resultEl } = findCvControls(el);

    checkBtn.click();
    await flush();

    expect(resultEl.hidden).toBe(false);
    expect(resultEl.textContent).toContain("No camera could be opened");
    expect(resultEl.classList.contains("settings-status-error")).toBe(true);
  });

  it("shows a distinct message when the camera process can't even be spawned", async () => {
    vi.mocked(cvSelftest).mockRejectedValue("Couldn't start the camera process: program not found");
    const { el } = fixture();
    const { checkBtn, resultEl } = findCvControls(el);

    checkBtn.click();
    await flush();

    expect(resultEl.textContent).toContain("Couldn't run the camera check");
    expect(resultEl.classList.contains("settings-status-error")).toBe(true);
    expect(checkBtn.disabled).toBe(false); // re-enabled after the failure, not stuck
  });
});

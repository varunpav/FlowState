// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatClockTime } from "../core/format";
import type { TimerRowModel } from "../core/timerRow";
import { initHomeView, type HomeViewElements, type HomeViewOptions } from "./homeView";

function buildElements(): HomeViewElements {
  return {
    heroEl: document.createElement("div"),
    heroLabelEl: document.createElement("p"),
    heroCountdownEl: document.createElement("p"),
    chipsEl: document.createElement("div"),
    ringContainerEl: document.createElement("div"),
    barsContainerEl: document.createElement("div"),
    streakEl: document.createElement("p"),
    monthStatsEl: document.createElement("p"),
    yearStatsEl: document.createElement("p"),
    waterEntryContainerEl: document.createElement("div"),
    intervalSliderEl: document.createElement("input"),
    intervalSliderValueEl: document.createElement("span"),
    startTimerBtn: document.createElement("button"),
    pauseBtn: document.createElement("button"),
  };
}

function fixture() {
  const el = buildElements();
  const options: HomeViewOptions = {
    bottleOz: 24,
    onWaterLogged: vi.fn(),
    onIntervalChanged: vi.fn(),
    onStartTimer: vi.fn(),
    onPauseToggle: vi.fn(),
  };
  const view = initHomeView(el, options);
  return { el, options, view };
}

const NOW_MS = Date.UTC(2026, 0, 15, 19, 42);

function model(overrides: Partial<TimerRowModel> = {}): TimerRowModel {
  return { hero: { state: "idle", remainingMs: null }, secondary: [], ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("renderTimers — hero states", () => {
  it("shows a clock and 'Not started' when hydration is enabled but idle", () => {
    const { el, view } = fixture();
    view.renderTimers(model({ hero: { state: "idle", remainingMs: null } }), NOW_MS);
    expect(el.heroLabelEl.textContent).toBe("Not started");
    // homeView.ts calls formatClockTime(nowMs) with no explicit timeZone,
    // so it renders in the host's local zone — compute the same way here
    // rather than hardcoding a zone-specific string.
    expect(el.heroCountdownEl.textContent).toBe(formatClockTime(NOW_MS));
    expect(el.heroEl.classList.contains("hero-off")).toBe(false);
  });

  it("shows a clock and 'Hydration off' when hydration is disabled, and applies hero-off", () => {
    const { el, view } = fixture();
    view.renderTimers(model({ hero: { state: "off", remainingMs: null } }), NOW_MS);
    expect(el.heroLabelEl.textContent).toBe("Hydration off");
    // homeView.ts calls formatClockTime(nowMs) with no explicit timeZone,
    // so it renders in the host's local zone — compute the same way here
    // rather than hardcoding a zone-specific string.
    expect(el.heroCountdownEl.textContent).toBe(formatClockTime(NOW_MS));
    expect(el.heroEl.classList.contains("hero-off")).toBe(true);
  });

  it("shows the countdown and 'Hydration' when running", () => {
    const { el, view } = fixture();
    view.renderTimers(model({ hero: { state: "running", remainingMs: 90_000 } }), NOW_MS);
    expect(el.heroLabelEl.textContent).toBe("Hydration");
    expect(el.heroCountdownEl.textContent).toBe("1:30");
  });

  it("keeps the countdown visible but swaps the label to 'Paused' while manually paused", () => {
    const { el, view } = fixture();
    view.setPause("manual");
    view.renderTimers(model({ hero: { state: "running", remainingMs: 90_000 } }), NOW_MS);
    expect(el.heroLabelEl.textContent).toBe("Paused");
    expect(el.heroCountdownEl.textContent).toBe("1:30");
  });

  it("reads 'System restart - Paused' for a system pause (sleep or restart)", () => {
    const { el, view } = fixture();
    view.setPause("system");
    view.renderTimers(model({ hero: { state: "running", remainingMs: 90_000 } }), NOW_MS);
    expect(el.heroLabelEl.textContent).toBe("System restart - Paused");
    expect(el.heroCountdownEl.textContent).toBe("1:30");
  });

  it("clicking Pause toggles the button label and the paused CSS class", () => {
    const { el, view } = fixture();
    view.setPause(null);
    expect(el.pauseBtn.textContent).toBe("Pause");
    expect(el.pauseBtn.classList.contains("pause-btn-active")).toBe(false);
    view.setPause("manual");
    expect(el.pauseBtn.textContent).toBe("Resume");
    expect(el.pauseBtn.classList.contains("pause-btn-active")).toBe(true);
    expect(el.heroEl.classList.contains("hero-paused")).toBe(true);
  });
});

describe("renderTimers — secondary row", () => {
  it("renders an idle preview dimmed and a running entry normal", () => {
    const { el, view } = fixture();
    view.renderTimers(
      model({
        secondary: [
          { kind: "pomodoro", label: "Pomodoro · Focus", displayMs: 25 * 60_000, running: false },
          { kind: "eyeBreak", label: "Eye break", displayMs: 42_000, running: true },
        ],
      }),
      NOW_MS,
    );
    const chips = el.chipsEl.querySelectorAll("span");
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent).toBe("Pomodoro · Focus 25:00");
    expect(chips[0]?.className).toContain("reminder-chip-idle");
    expect(chips[1]?.textContent).toBe("Eye break 0:42");
    expect(chips[1]?.className).not.toContain("reminder-chip-idle");
  });
});

describe("renderTimers — Start/Reset button", () => {
  it("reads 'Start timer' and is disabled when nothing is enabled", () => {
    const { el, view } = fixture();
    view.renderTimers(model({ hero: { state: "off", remainingMs: null }, secondary: [] }), NOW_MS);
    expect(el.startTimerBtn.textContent).toBe("Start timer");
    expect(el.startTimerBtn.disabled).toBe(true);
  });

  it("reads 'Start timer' and is enabled when idle but something is enabled", () => {
    const { el, view } = fixture();
    view.renderTimers(
      model({
        hero: { state: "off", remainingMs: null },
        secondary: [{ kind: "eyeBreak", label: "Eye break", displayMs: 1_200_000, running: false }],
      }),
      NOW_MS,
    );
    expect(el.startTimerBtn.textContent).toBe("Start timer");
    expect(el.startTimerBtn.disabled).toBe(false);
  });

  it("reads 'Reset timer' when hydration itself is running", () => {
    const { el, view } = fixture();
    view.renderTimers(model({ hero: { state: "running", remainingMs: 1_000 } }), NOW_MS);
    expect(el.startTimerBtn.textContent).toBe("Reset timer");
    expect(el.startTimerBtn.disabled).toBe(false);
  });

  it("reads 'Reset timer' when hydration is off but a secondary reminder is running", () => {
    const { el, view } = fixture();
    view.renderTimers(
      model({
        hero: { state: "off", remainingMs: null },
        secondary: [{ kind: "pomodoro", label: "Pomodoro · Focus", displayMs: 1_000, running: true }],
      }),
      NOW_MS,
    );
    expect(el.startTimerBtn.textContent).toBe("Reset timer");
  });
});

describe("renderTimers — Pause button visibility", () => {
  it("hides Pause when nothing is armed", () => {
    const { el, view } = fixture();
    view.renderTimers(model({ hero: { state: "idle", remainingMs: null }, secondary: [] }), NOW_MS);
    expect(el.pauseBtn.hidden).toBe(true);
  });

  it("shows Pause once hydration is armed", () => {
    const { el, view } = fixture();
    view.renderTimers(model({ hero: { state: "running", remainingMs: 90_000 } }), NOW_MS);
    expect(el.pauseBtn.hidden).toBe(false);
  });

  it("shows Pause when only a secondary reminder is armed, even with hydration off", () => {
    const { el, view } = fixture();
    view.renderTimers(
      model({
        hero: { state: "off", remainingMs: null },
        secondary: [{ kind: "eyeBreak", label: "Eye break", displayMs: 1_000, running: true }],
      }),
      NOW_MS,
    );
    expect(el.pauseBtn.hidden).toBe(false);
  });
});

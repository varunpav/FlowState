// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PomodoroSettings, ReminderSettings } from "../core/settings";
import { mountPomodoroCard, mountReminderCard } from "./reminderCard";

function reminderDefaults(): ReminderSettings {
  return { enabled: true, intervalMs: 120 * 60_000, alertStyle: "takeover" };
}

function pomodoroDefaults(): PomodoroSettings {
  return { enabled: true, focusMs: 25 * 60_000, breakMs: 5 * 60_000, alertStyle: "takeover" };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mountReminderCard", () => {
  it("builds a <details> card labeled and pre-opened by its initial enabled state", () => {
    const container = document.createElement("div");
    mountReminderCard(container, "hydration", reminderDefaults());

    const details = container.querySelector("details")!;
    expect(details.className).toContain("settings-card");
    expect(details.open).toBe(true);
    expect(details.querySelector("summary")?.textContent).toContain("Hydration");
  });

  it("starts closed when the initial value is disabled", () => {
    const container = document.createElement("div");
    mountReminderCard(container, "eyeBreak", { ...reminderDefaults(), enabled: false });
    expect(container.querySelector("details")!.open).toBe(false);
  });

  it("getValue reads back exactly what setValue wrote", () => {
    const container = document.createElement("div");
    const card = mountReminderCard(container, "standUp", reminderDefaults());

    card.setValue({ enabled: false, intervalMs: 45 * 60_000, alertStyle: "notify" });

    expect(card.getValue()).toEqual({ enabled: false, intervalMs: 45 * 60_000, alertStyle: "notify" });
  });

  it("getValue reflects live edits to the interval field and the alert-style segmented control", () => {
    const container = document.createElement("div");
    const card = mountReminderCard(container, "hydration", reminderDefaults());

    const intervalInput = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    intervalInput.value = "90";
    intervalInput.dispatchEvent(new Event("change"));

    const notifyBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Notification")!;
    notifyBtn.click();

    expect(card.getValue()).toEqual({ enabled: true, intervalMs: 90 * 60_000, alertStyle: "notify" });
  });

  it("dims the body when the enable switch is toggled off, without losing the field values underneath", () => {
    const container = document.createElement("div");
    const card = mountReminderCard(container, "hydration", reminderDefaults());
    const body = container.querySelector(".settings-card-body")!;
    expect(body.className).not.toContain("settings-card-body-disabled");

    const enableSwitch = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    enableSwitch.click();

    expect(body.className).toContain("settings-card-body-disabled");
    expect(card.getValue().intervalMs).toBe(reminderDefaults().intervalMs); // unchanged, just dimmed
  });

  it("calls onChange for the enable switch, the interval field, and the alert style — not on mount", () => {
    const container = document.createElement("div");
    const onChange = vi.fn();
    mountReminderCard(container, "hydration", reminderDefaults(), onChange);
    expect(onChange).not.toHaveBeenCalled();

    container.querySelector<HTMLButtonElement>('button[role="switch"]')!.click();
    expect(onChange).toHaveBeenCalledTimes(1);

    const intervalInput = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    intervalInput.value = "30";
    intervalInput.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("bodyEl is the actual card body, so appending to it (as settingsPanel.ts does for the CV group) lands inside the card", () => {
    const container = document.createElement("div");
    const card = mountReminderCard(container, "hydration", reminderDefaults());

    const marker = document.createElement("div");
    marker.textContent = "cv group";
    card.bodyEl.append(marker);

    expect(container.querySelector(".settings-card-body")?.contains(marker)).toBe(true);
  });

  it("setValue resyncs the dimmed state to match the value being restored", () => {
    const container = document.createElement("div");
    const card = mountReminderCard(container, "hydration", reminderDefaults());
    const body = container.querySelector(".settings-card-body")!;

    card.setValue({ ...reminderDefaults(), enabled: false });
    expect(body.className).toContain("settings-card-body-disabled");

    card.setValue({ ...reminderDefaults(), enabled: true });
    expect(body.className).not.toContain("settings-card-body-disabled");
  });
});

describe("mountPomodoroCard", () => {
  it("offers exactly the 25/55 focus and 5/15 break choices, defaulting to the initial value", () => {
    const container = document.createElement("div");
    mountPomodoroCard(container, pomodoroDefaults());

    const labels = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(
      expect.arrayContaining(["25 min", "55 min", "5 min", "15 min", "Full screen", "Notification"]),
    );

    const active = container.querySelectorAll(".segmented-active");
    const activeLabels = Array.from(active).map((b) => b.textContent);
    expect(activeLabels).toContain("25 min");
    expect(activeLabels).toContain("5 min");
  });

  it("getValue reflects picking a different focus/break combination", () => {
    const container = document.createElement("div");
    const card = mountPomodoroCard(container, pomodoroDefaults());

    const fiftyFive = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "55 min")!;
    fiftyFive.click();
    const fifteen = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "15 min")!;
    fifteen.click();

    expect(card.getValue()).toEqual({
      enabled: true,
      focusMs: 55 * 60_000,
      breakMs: 15 * 60_000,
      alertStyle: "takeover",
    });
  });

  it("setValue round-trips through getValue", () => {
    const container = document.createElement("div");
    const card = mountPomodoroCard(container, pomodoroDefaults());

    const next: PomodoroSettings = { enabled: false, focusMs: 55 * 60_000, breakMs: 15 * 60_000, alertStyle: "notify" };
    card.setValue(next);

    expect(card.getValue()).toEqual(next);
  });

  it("is labeled Pomodoro regardless of the settings passed in", () => {
    const container = document.createElement("div");
    mountPomodoroCard(container, pomodoroDefaults());
    expect(container.querySelector("summary")?.textContent).toContain("Pomodoro");
  });
});

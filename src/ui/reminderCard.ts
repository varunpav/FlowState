import { ALERT_STYLES, REMINDER_LABELS, type AlertStyle, type ReminderKind } from "../core/reminders";
import type { PomodoroSettings, ReminderSettings } from "../core/settings";
import { createSwitch } from "./switch";

const ALERT_STYLE_LABELS: Record<AlertStyle, string> = {
  takeover: "Full screen",
  notify: "Notification",
};

const SVG_NS = "http://www.w3.org/2000/svg";

/** One glance-recognizable glyph per reminder kind, matching the .settings-icon treatment used for the top-level Settings sections in index.html. */
const REMINDER_ICON_PATHS: Record<ReminderKind, string[]> = {
  hydration: ["M12 2.5C9 7 6 10.8 6 14.5a6 6 0 0 0 12 0C18 10.8 15 7 12 2.5Z"],
  pomodoro: ["M12 9v4l3 2", "M9 2h6"],
  eyeBreak: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"],
  standUp: ["M12 8v7M8 11l4-1 4 1M9 21l3-6 3 6"],
};

function buildReminderIcon(kind: ReminderKind): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "settings-icon";

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");

  if (kind === "pomodoro") {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", "13");
    circle.setAttribute("r", "8");
    svg.append(circle);
  }
  if (kind === "eyeBreak") {
    const pupil = document.createElementNS(SVG_NS, "circle");
    pupil.setAttribute("cx", "12");
    pupil.setAttribute("cy", "12");
    pupil.setAttribute("r", "3");
    svg.append(pupil);
  }
  if (kind === "standUp") {
    const head = document.createElementNS(SVG_NS, "circle");
    head.setAttribute("cx", "12");
    head.setAttribute("cy", "5");
    head.setAttribute("r", "2.2");
    svg.append(head);
  }

  for (const d of REMINDER_ICON_PATHS[kind]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }

  wrap.append(svg);
  return wrap;
}

function buildSegmented(
  values: readonly AlertStyle[],
  initial: AlertStyle,
  labels: Record<AlertStyle, string> = ALERT_STYLE_LABELS,
  onChange?: () => void,
): { el: HTMLElement; get(): AlertStyle; set(value: AlertStyle): void } {
  const el = document.createElement("div");
  el.className = "segmented";
  let current = initial;

  const buttons = values.map((value) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = labels[value];
    btn.dataset["value"] = value;
    btn.addEventListener("click", () => {
      current = value;
      sync();
      onChange?.();
    });
    el.append(btn);
    return btn;
  });

  function sync() {
    buttons.forEach((btn, i) => {
      btn.classList.toggle("segmented-active", values[i] === current);
    });
  }
  sync();

  return {
    el,
    get: () => current,
    set(value: AlertStyle) {
      current = value;
      sync();
    },
  };
}

function buildMinutesField(
  labelText: string,
  initialMinutes: number,
  onChange?: () => void,
): { el: HTMLElement; input: HTMLInputElement } {
  const label = document.createElement("label");
  label.className = "settings-field";
  label.append(document.createTextNode(labelText));
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.value = String(initialMinutes);
  // change, not input — committing per keystroke would write "2" on the way
  // to "20" and thrash the store with invalid intermediate values.
  input.addEventListener("change", () => onChange?.());
  label.append(input);
  return { el: label, input };
}

export interface ReminderCardHandle {
  getValue(): ReminderSettings;
  setValue(value: ReminderSettings): void;
  /** The card's expandable body — settingsPanel.ts appends the hydration-only CV verification row into this, after the standard fields. */
  bodyEl: HTMLElement;
}

/** One accordion card for hydration/eyeBreak/standUp: enable, interval, attention-grabber style. */
export function mountReminderCard(
  container: HTMLElement,
  kind: ReminderKind,
  initial: ReminderSettings,
  onChange?: () => void,
): ReminderCardHandle {
  const details = document.createElement("details");
  details.className = "settings-card";
  details.open = initial.enabled;

  const summary = document.createElement("summary");
  const enableSwitch = createSwitch(initial.enabled, () => {
    syncEnabledState();
    onChange?.();
  });
  const labelSpan = document.createElement("span");
  labelSpan.textContent = REMINDER_LABELS[kind];
  summary.append(buildReminderIcon(kind), enableSwitch.el, labelSpan);

  const body = document.createElement("div");
  body.className = "settings-card-body";

  const interval = buildMinutesField("Interval (minutes)", initial.intervalMs / 60_000, onChange);

  const alertLabel = document.createElement("div");
  alertLabel.className = "settings-field";
  alertLabel.append(document.createTextNode("Attention grabber"));
  const segmented = buildSegmented(ALERT_STYLES, initial.alertStyle, ALERT_STYLE_LABELS, onChange);
  alertLabel.append(segmented.el);

  body.append(interval.el, alertLabel);
  details.append(summary, body);
  container.append(details);

  function syncEnabledState() {
    body.classList.toggle("settings-card-body-disabled", !enableSwitch.get());
  }
  syncEnabledState();

  return {
    getValue(): ReminderSettings {
      return {
        enabled: enableSwitch.get(),
        intervalMs: Number(interval.input.value) * 60_000,
        alertStyle: segmented.get(),
      };
    },
    setValue(value: ReminderSettings) {
      enableSwitch.set(value.enabled);
      interval.input.value = String(value.intervalMs / 60_000);
      segmented.set(value.alertStyle);
      syncEnabledState();
    },
    bodyEl: body,
  };
}

export interface PomodoroCardHandle {
  getValue(): PomodoroSettings;
  setValue(value: PomodoroSettings): void;
}

const FOCUS_CHOICES_MIN = [25, 55] as const;
const BREAK_CHOICES_MIN = [5, 15] as const;

function buildChoiceField<T extends number>(
  labelText: string,
  choices: readonly T[],
  initial: T,
  onChange?: () => void,
): { el: HTMLElement; get(): T; set(value: T): void } {
  const label = document.createElement("div");
  label.className = "settings-field";
  label.append(document.createTextNode(labelText));

  const group = document.createElement("div");
  group.className = "segmented";
  let current = initial;

  const buttons = choices.map((choice) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `${choice} min`;
    btn.addEventListener("click", () => {
      current = choice;
      sync();
      onChange?.();
    });
    group.append(btn);
    return btn;
  });

  function sync() {
    buttons.forEach((btn, i) => btn.classList.toggle("segmented-active", choices[i] === current));
  }
  sync();

  label.append(group);
  return { el: label, get: () => current, set: (value: T) => { current = value; sync(); } };
}

/** Pomodoro's card: enable, 25|55 focus choice, 5|15 break choice, attention-grabber style. No single interval — it alternates. */
export function mountPomodoroCard(
  container: HTMLElement,
  initial: PomodoroSettings,
  onChange?: () => void,
): PomodoroCardHandle {
  const details = document.createElement("details");
  details.className = "settings-card";
  details.open = initial.enabled;

  const summary = document.createElement("summary");
  const enableSwitch = createSwitch(initial.enabled, () => {
    syncEnabledState();
    onChange?.();
  });
  const labelSpan = document.createElement("span");
  labelSpan.textContent = "Pomodoro";
  summary.append(buildReminderIcon("pomodoro"), enableSwitch.el, labelSpan);

  const body = document.createElement("div");
  body.className = "settings-card-body";

  const focus = buildChoiceField("Focus session", FOCUS_CHOICES_MIN, (initial.focusMs / 60_000) as 25 | 55, onChange);
  const rest = buildChoiceField("Break", BREAK_CHOICES_MIN, (initial.breakMs / 60_000) as 5 | 15, onChange);

  const alertLabel = document.createElement("div");
  alertLabel.className = "settings-field";
  alertLabel.append(document.createTextNode("Attention grabber"));
  const segmented = buildSegmented(ALERT_STYLES, initial.alertStyle, ALERT_STYLE_LABELS, onChange);
  alertLabel.append(segmented.el);

  body.append(focus.el, rest.el, alertLabel);
  details.append(summary, body);
  container.append(details);

  function syncEnabledState() {
    body.classList.toggle("settings-card-body-disabled", !enableSwitch.get());
  }
  syncEnabledState();

  return {
    getValue(): PomodoroSettings {
      return {
        enabled: enableSwitch.get(),
        focusMs: focus.get() * 60_000,
        breakMs: rest.get() * 60_000,
        alertStyle: segmented.get(),
      };
    },
    setValue(value: PomodoroSettings) {
      enableSwitch.set(value.enabled);
      focus.set((value.focusMs / 60_000) as 25 | 55);
      rest.set((value.breakMs / 60_000) as 5 | 15);
      segmented.set(value.alertStyle);
      syncEnabledState();
    },
  };
}

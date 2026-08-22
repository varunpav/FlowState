// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createSwitch } from "./switch";

describe("createSwitch", () => {
  it("starts at the given initial value, reflected in both the class and aria-checked", () => {
    const on = createSwitch(true);
    expect(on.get()).toBe(true);
    expect(on.el.classList.contains("switch-on")).toBe(true);
    expect(on.el.getAttribute("aria-checked")).toBe("true");

    const off = createSwitch(false);
    expect(off.get()).toBe(false);
    expect(off.el.classList.contains("switch-on")).toBe(false);
    expect(off.el.getAttribute("aria-checked")).toBe("false");
  });

  it("toggles on click and fires onChange with the new value", () => {
    const onChange = vi.fn();
    const s = createSwitch(false, onChange);

    s.el.click();
    expect(s.get()).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true);

    s.el.click();
    expect(s.get()).toBe(false);
    expect(onChange).toHaveBeenCalledWith(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("set() repaints without firing onChange — a programmatic refresh must not read back as a user edit", () => {
    const onChange = vi.fn();
    const s = createSwitch(false, onChange);

    s.set(true);

    expect(s.get()).toBe(true);
    expect(s.el.classList.contains("switch-on")).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stops the click from propagating — a switch nested in a <summary> must not also toggle the parent <details>", () => {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const s = createSwitch(false);
    summary.append(s.el);
    details.append(summary);
    document.body.append(details);

    const summaryClick = vi.fn();
    summary.addEventListener("click", summaryClick);

    s.el.click();

    expect(s.get()).toBe(true); // the switch itself still toggled
    expect(summaryClick).not.toHaveBeenCalled(); // but the click never reached <summary>

    details.remove();
  });

  it("is a real <button>, natively focusable with role=switch for assistive tech", () => {
    const s = createSwitch(false);
    expect(s.el.tagName).toBe("BUTTON");
    expect(s.el.getAttribute("type")).toBe("button");
    expect(s.el.getAttribute("role")).toBe("switch");
  });
});

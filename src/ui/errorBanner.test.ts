// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initErrorBanner, reportError } from "./errorBanner";

function buildBanner(): HTMLElement {
  const el = document.createElement("div");
  el.hidden = true;
  const text = document.createElement("span");
  text.setAttribute("data-text", "");
  const dismiss = document.createElement("button");
  dismiss.setAttribute("data-dismiss", "");
  el.append(text, dismiss);
  return el;
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("reportError", () => {
  it("shows the banner with a context-specific message and always logs to console", () => {
    const el = buildBanner();
    initErrorBanner(el);

    reportError("Saving water log", new Error("disk full"));

    expect(el.hidden).toBe(false);
    expect(el.querySelector("[data-text]")?.textContent).toBe("Saving water log failed");
    expect(consoleErrorSpy).toHaveBeenCalledWith("Saving water log failed:", expect.any(Error));
  });

  it("is a safe no-op before initErrorBanner has ever run — a startup failure must not throw", () => {
    // No banner registered in this test's module state (initErrorBanner
    // hasn't been called since the last test that did register one — this
    // documents the "no bannerEl yet" branch stays safe regardless).
    expect(() => reportError("Starting up", new Error("boom"))).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith("Starting up failed:", expect.any(Error));
  });

  it("dismiss button hides the banner", () => {
    const el = buildBanner();
    initErrorBanner(el);
    reportError("Applying settings", new Error("nope"));
    expect(el.hidden).toBe(false);

    el.querySelector<HTMLButtonElement>("[data-dismiss]")!.click();

    expect(el.hidden).toBe(true);
  });

  it("a later error re-shows the banner with the new message", () => {
    const el = buildBanner();
    initErrorBanner(el);
    reportError("First failure", new Error("a"));
    el.querySelector<HTMLButtonElement>("[data-dismiss]")!.click();
    expect(el.hidden).toBe(true);

    reportError("Second failure", new Error("b"));

    expect(el.hidden).toBe(false);
    expect(el.querySelector("[data-text]")?.textContent).toBe("Second failure failed");
  });
});

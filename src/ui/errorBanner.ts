/**
 * A single fixed banner for failures that would otherwise be silent —
 * fire-and-forget `void somePromise()` calls whose rejection previously went
 * nowhere. This is the exact pattern that hid the v2.3 autostart bug for an
 * entire release line: no console error, no UI feedback, the button just
 * did nothing. `reportError` exists to make that structurally hard to
 * repeat outside settingsPanel.ts (which already has its own inline status
 * line for save failures).
 */
let bannerEl: HTMLElement | null = null;

export function initErrorBanner(el: HTMLElement): void {
  bannerEl = el;
  const dismissBtn = el.querySelector<HTMLButtonElement>("[data-dismiss]");
  dismissBtn?.addEventListener("click", () => {
    el.hidden = true;
  });
}

export function reportError(context: string, err: unknown): void {
  console.error(`${context} failed:`, err);
  if (!bannerEl) return;
  const textEl = bannerEl.querySelector<HTMLElement>("[data-text]");
  if (textEl) textEl.textContent = `${context} failed`;
  bannerEl.hidden = false;
}

export interface SwitchHandle {
  el: HTMLElement;
  get(): boolean;
  set(value: boolean): void;
}

/**
 * Custom toggle switch — deliberately not a native `<input type="checkbox">`.
 * A native checkbox nested inside a `<summary>` (the reminder-card pattern)
 * gets its click swallowed/reverted, because clicking anything inside a
 * `<summary>` also triggers the summary's own activation behavior, which
 * toggles the parent `<details>` — that's a structural quirk, not a
 * listener bug, so no amount of `addEventListener("change", …)` fixes it.
 *
 * `stopPropagation()` called BEFORE toggling is the entire fix: the click
 * never reaches `<summary>`, so the details element stops stealing the
 * interaction. Get that ordering wrong and this regresses to looking
 * exactly like the original bug.
 *
 * A `<button>` is natively focusable and Space/Enter-activated, so no
 * `tabindex`/keydown handling is needed; `role="switch"` + `aria-checked`
 * keeps it announced correctly to assistive tech.
 */
export function createSwitch(initial: boolean, onChange?: (value: boolean) => void): SwitchHandle {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "switch";
  el.setAttribute("role", "switch");

  const thumb = document.createElement("span");
  thumb.className = "switch-thumb";
  el.append(thumb);

  let value = initial;

  function sync() {
    el.setAttribute("aria-checked", String(value));
    el.classList.toggle("switch-on", value);
  }
  sync();

  el.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    value = !value;
    sync();
    onChange?.(value);
  });

  return {
    el,
    get: () => value,
    set(next: boolean) {
      value = next;
      sync();
    },
  };
}

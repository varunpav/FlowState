import { getCurrentWindow } from "@tauri-apps/api/window";
import { isIdle } from "./core/idlePolicy";
import { formatCountdown } from "./core/schedule";
import { confirmHydration, getState, onHydrationDue, onTick, setDeadline } from "./ipc";

let countdownEl: HTMLElement | null;
let idleEl: HTMLElement | null;
let dueEl: HTMLElement | null;
let intervalInputEl: HTMLInputElement | null;

async function startInterval(minutes: number) {
  const state = await getState();
  await setDeadline(state.nowMs + minutes * 60 * 1000);
  if (dueEl) dueEl.hidden = true;
}

function render(remainingMs: number | null, idleSeconds: number) {
  if (countdownEl) {
    countdownEl.textContent = remainingMs === null ? "--:--" : formatCountdown(remainingMs);
  }
  if (idleEl) {
    idleEl.textContent = isIdle(idleSeconds) ? `Idle (${idleSeconds}s)` : "Active";
  }
  void getCurrentWindow().setTitle(
    remainingMs === null ? "Flow State" : `${formatCountdown(remainingMs)} — Flow State`,
  );
}

window.addEventListener("DOMContentLoaded", async () => {
  countdownEl = document.querySelector("#countdown");
  idleEl = document.querySelector("#idle");
  dueEl = document.querySelector("#due");
  intervalInputEl = document.querySelector("#interval-minutes");

  document.querySelector("#start-interval")?.addEventListener("click", async () => {
    const minutes = Number(intervalInputEl?.value ?? "120");
    await startInterval(minutes);
  });

  document.querySelector("#fire-in-10s")?.addEventListener("click", async () => {
    const state = await getState();
    await setDeadline(state.nowMs + 10_000);
    if (dueEl) dueEl.hidden = true;
  });

  document.querySelector("#confirm")?.addEventListener("click", async () => {
    await confirmHydration();
    if (dueEl) dueEl.hidden = true;
  });

  await onTick((payload) => render(payload.remainingMs, payload.idleSeconds));
  await onHydrationDue(() => {
    if (dueEl) dueEl.hidden = false;
  });

  const initial = await getState();
  render(
    initial.deadlineMs === null ? null : Math.max(0, initial.deadlineMs - initial.nowMs),
    initial.idleSeconds,
  );
});

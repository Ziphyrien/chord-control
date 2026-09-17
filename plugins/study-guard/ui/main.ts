import { callHost } from "../../../sdk/ui.ts";
import type { Json } from "../../../shared/protocol.ts";
import { message } from "../../../shared/validation.ts";
const status = document.querySelector<HTMLElement>("#status")!;
const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-browser]")];
let active = false;
let busy = false;
let epoch = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
function render(value: Json, requested = false): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.active !== "boolean" ||
    !Array.isArray(value.pending) ||
    typeof value.last !== "string"
  )
    throw new Error("保护状态读取失败，请稍后重试");
  for (const button of buttons)
    button.disabled = !value.active || value.pending.includes(button.dataset.browser!);
  status.textContent =
    requested && value.requested === true
      ? "请在密保盘中验证"
      : value.pending.length
        ? "正在等待密保盘验证"
        : value.last || (value.active ? "学习保护已启用" : "学习保护未启用");
}
function schedule(): void {
  clearTimeout(timer);
  if (active)
    timer = setTimeout(() => {
      void update();
    }, 1500);
}
async function update(browser?: string): Promise<void> {
  if (!active || busy) return;
  busy = true;
  clearTimeout(timer);
  const expected = epoch;
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    const value = await callHost(browser ? "open_browser" : "status", browser ?? null);
    if (active && expected === epoch) render(value, !!browser);
  } catch (error) {
    if (active && expected === epoch) status.textContent = message(error);
  } finally {
    busy = false;
    schedule();
  }
}
for (const button of buttons)
  button.addEventListener("click", () => {
    void update(button.dataset.browser);
  });
window.addEventListener("pagehide", () => {
  active = false;
  epoch++;
  clearTimeout(timer);
});
function start(): void {
  if (!active) {
    active = true;
    void update();
  }
}
window.addEventListener("pageshow", start);
start();

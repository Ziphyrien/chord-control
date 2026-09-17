import { callHost } from "../../../sdk/ui.ts";
import { CONFIRM_KEY, GRID_SIZE } from "../input.ts";
import { PadSession } from "./session.ts";

const cells = document.querySelector<HTMLElement>("#cells")!;
const title = document.querySelector<HTMLElement>("#title")!;
const input = document.querySelector<HTMLElement>("#input")!;
const status = document.querySelector<HTMLElement>("#status")!;
const buttons = Array.from({ length: GRID_SIZE ** 2 }, (_, index) => {
  const button = document.createElement("button");
  button.type = "button";
  button.disabled = true;
  button.addEventListener("click", () => {
    void session.select(index);
  });
  button.addEventListener("keydown", (event) => {
    const movement: Record<string, number | undefined> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -GRID_SIZE,
      ArrowDown: GRID_SIZE,
    };
    const shift = movement[event.key];
    if (shift !== undefined && index + shift >= 0 && index + shift < buttons.length) {
      event.preventDefault();
      buttons[index + shift].focus();
    } else if (event.key === "Backspace") {
      event.preventDefault();
      session.backspace();
    }
  });
  cells.append(button);
  return button;
});
const session = new PadSession(callHost, (state) => {
  title.textContent = state.view?.title ?? "密保盘";
  input.textContent = "•".repeat(state.count);
  input.setAttribute("aria-label", `已输入 ${state.count} 位`);
  status.textContent = state.message;
  cells.setAttribute("aria-busy", String(state.busy));
  buttons.forEach((button, index) => {
    const value = state.view?.cells[index];
    button.textContent = value ?? "·";
    button.disabled = state.busy || !state.view;
    button.setAttribute("aria-label", value === CONFIRM_KEY ? "确认" : (value ?? "空"));
  });
});
window.addEventListener("pagehide", () => session.pause());
window.addEventListener("pageshow", () => session.start());
session.start();

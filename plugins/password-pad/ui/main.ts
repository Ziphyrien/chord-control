import { callHost } from "../../../sdk/ui.ts";
type View = { id: string; title: string; size: number; cells: string[]; expiresAt: number };
const board = document.querySelector<HTMLElement>("#board")!,
  cells = document.querySelector<HTMLElement>("#cells")!,
  trace = document.querySelector<SVGPolylineElement>("#trace")!,
  title = document.querySelector<HTMLElement>("#title")!,
  status = document.querySelector<HTMLElement>("#status")!;
let view: View | null = null,
  path: number[] = [],
  down = false,
  busy = false,
  previous: { x: number; y: number } | undefined;
const buttons = Array.from({ length: 36 }, (_, index) => {
  const button = document.createElement("button");
  button.className = "cell";
  button.dataset.index = String(index);
  cells.append(button);
  return button;
});
function render(next: View | null): void {
  const changed = JSON.stringify(next) !== JSON.stringify(view);
  view = next;
  if (!changed || down) return;
  path = [];
  trace.setAttribute("points", "");
  title.textContent = next?.title ?? "密保盘";
  buttons.forEach((button, index) => {
    button.textContent = next?.cells[index] ?? "·";
    button.disabled = !next;
    button.setAttribute("aria-label", next?.cells[index] ?? "空");
  });
}
async function refresh(): Promise<void> {
  if (down || busy) return;
  try {
    render((await callHost("challenge")) as View | null);
  } catch (error) {
    status.textContent = String(error);
  }
}
function add(index: number): void {
  if (!view || index < 0 || index >= 36 || path.includes(index)) return;
  const last = path.at(-1);
  if (
    last !== undefined &&
    (Math.abs((last % 6) - (index % 6)) > 1 ||
      Math.abs(Math.floor(last / 6) - Math.floor(index / 6)) > 1)
  )
    return;
  path.push(index);
  buttons[index].textContent = "";
  buttons[index].setAttribute("aria-label", "已划过");
}
function point(event: PointerEvent): { x: number; y: number } {
  const rect = board.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}
function move(point: { x: number; y: number }): void {
  const from = previous ?? point,
    steps = Math.max(1, Math.ceil(Math.hypot(point.x - from.x, point.y - from.y) / 8));
  for (let step = 0; step <= steps; step++) {
    const x = from.x + ((point.x - from.x) * step) / steps,
      y = from.y + ((point.y - from.y) * step) / steps;
    if (x >= 0 && x < 336 && y >= 0 && y < 336) add(Math.floor(y / 56) * 6 + Math.floor(x / 56));
  }
  previous = point;
  trace.setAttribute(
    "points",
    [
      ...path.map((index) => `${(index % 6) * 56 + 28},${Math.floor(index / 6) * 56 + 28}`),
      `${point.x},${point.y}`,
    ].join(" "),
  );
}
async function submit(): Promise<void> {
  down = false;
  previous = undefined;
  if (!view || !path.length) return;
  busy = true;
  try {
    const result = (await callHost("submit", { id: view.id, path })) as { approved: boolean };
    status.textContent = result.approved ? "验证成功" : "未通过，请重新连接";
  } catch (error) {
    status.textContent = String(error);
  } finally {
    busy = false;
    view = null;
    await refresh();
  }
}
board.addEventListener("pointerdown", (event) => {
  if (!view || busy || event.button !== 0) return;
  event.preventDefault();
  board.setPointerCapture(event.pointerId);
  down = true;
  path = [];
  previous = undefined;
  status.textContent = "";
  move(point(event));
});
board.addEventListener("pointermove", (event) => {
  if (down) move(point(event));
});
board.addEventListener("pointerup", () => {
  if (down) void submit();
});
board.addEventListener("pointercancel", () => {
  down = false;
  view = null;
  void refresh();
});
board.addEventListener("keydown", (event) => {
  if (!view || busy) return;
  const index = Number((event.target as HTMLElement).dataset.index);
  if (event.key === " ") {
    event.preventDefault();
    down = true;
    add(index);
  } else if (event.key === "Enter" && down) {
    event.preventDefault();
    void submit();
  } else {
    const delta = (
      { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -6, ArrowDown: 6 } as Record<string, number>
    )[event.key];
    if (delta && index + delta >= 0 && index + delta < 36) {
      event.preventDefault();
      buttons[index + delta].focus();
      if (down) add(index + delta);
    }
  }
});
document.querySelector("#practice")!.addEventListener("click", () => {
  void callHost("practice").then(refresh);
});
document.querySelector("#cancel")!.addEventListener("click", () => {
  if (view) void callHost("cancel", { id: view.id }).then(refresh);
});
const timer = setInterval(() => {
  void refresh();
}, 750);
window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
void refresh();

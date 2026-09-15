import { callHost } from "../../../sdk/ui.ts";
const status = document.querySelector<HTMLElement>("#status")!;
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-browser]"))
  button.addEventListener("click", () => {
    void callHost("open_browser", button.dataset.browser!)
      .then(() => {
        status.textContent = "请在密保盘中验证";
      })
      .catch((error) => {
        status.textContent = String(error);
      });
  });
const timer = setInterval(() => {
  void callHost("status")
    .then((value) => {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof value.last === "string" &&
        value.last
      )
        status.textContent = value.last;
    })
    .catch((error) => {
      status.textContent = String(error);
    });
}, 1500);
window.addEventListener("pagehide", () => clearInterval(timer), { once: true });

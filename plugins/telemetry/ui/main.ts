import { callHost } from "../../../sdk/ui.ts";
const status = document.querySelector<HTMLPreElement>("#status")!;
const send = document.querySelector<HTMLButtonElement>("#send")!;
const report = document.querySelector<HTMLButtonElement>("#report")!;
const detail = document.querySelector<HTMLPreElement>("#detail")!;
async function refresh(method = "status") {
  send.disabled = true;
  try {
    status.textContent = JSON.stringify(await callHost(method), null, 2);
  } catch (error) {
    status.textContent = String(error);
  } finally {
    send.disabled = false;
  }
}
send.onclick = () => {
  void refresh("send");
};
report.onclick = () => {
  void callHost("report")
    .then((value) => {
      detail.hidden = false;
      detail.textContent = JSON.stringify(value, null, 2);
    })
    .catch((error) => {
      status.textContent = String(error);
    });
};
void refresh();

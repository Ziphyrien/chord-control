import { callHost } from "../../../sdk/ui.ts";
const info = document.querySelector<HTMLDListElement>("#info")!;
const note = document.querySelector<HTMLTextAreaElement>("#note")!;
const status = document.querySelector<HTMLOutputElement>("#status")!;
async function run(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}
async function refresh(): Promise<void> {
  const value = await callHost("info");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("无法读取系统信息");
  const labels: Record<string, string> = {
    hostname: "计算机名称",
    platform: "操作系统",
    arch: "架构",
    uptimeMinutes: "运行时间",
    memoryGiB: "内存",
  };
  info.replaceChildren();
  for (const [key, label] of Object.entries(labels)) {
    if (value[key] === undefined) continue;
    const term = document.createElement("dt"),
      detail = document.createElement("dd");
    term.textContent = label;
    const item = value[key];
    detail.textContent =
      key === "memoryGiB"
        ? `${item} GB`
        : key === "uptimeMinutes"
          ? `${item} 分钟`
          : item === "win32"
            ? "Windows"
            : String(item);
    info.append(term, detail);
  }
}
document.querySelector("#refresh")!.addEventListener("click", () => void run(refresh));
document.querySelector("#save")!.addEventListener(
  "click",
  () =>
    void run(async () => {
      await callHost("save_note", note.value);
      status.textContent = "已保存";
    }),
);
void run(async () => {
  await refresh();
  note.value = String(await callHost("read_note"));
});

import { callHost } from "../../../sdk/ui.ts";
const info = document.querySelector<HTMLDListElement>("#info")!;
const note = document.querySelector<HTMLTextAreaElement>("#note")!;
const status = document.querySelector<HTMLOutputElement>("#status")!;
const save = document.querySelector<HTMLButtonElement>("#save")!;
const refresh = document.querySelector<HTMLButtonElement>("#refresh")!;
let active = true;
let revision = 0;
let loading = false;
let saving = false;
let noteLoaded = false;
const message = (value: unknown) => {
  if (active) status.textContent = value instanceof Error ? value.message : String(value);
};
note.addEventListener("input", () => {
  revision++;
  message("尚未保存");
});
async function refreshInfo(): Promise<void> {
  if (!active || loading) return;
  loading = true;
  refresh.disabled = true;
  try {
    const value = await callHost("info");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("无法读取系统信息");
    if (!active) return;
    const labels = {
      hostname: "计算机名称",
      platform: "操作系统",
      arch: "架构",
      uptimeMinutes: "运行时间",
      memoryGiB: "内存",
    };
    const fragment = document.createDocumentFragment();
    for (const [key, label] of Object.entries(labels)) {
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      term.textContent = label;
      const item = value[key];
      detail.textContent =
        key === "memoryGiB"
          ? `${item} GB`
          : key === "uptimeMinutes"
            ? `${item} 分钟`
            : item === "win32"
              ? "Windows"
              : String(item ?? "—");
      fragment.append(term, detail);
    }
    info.replaceChildren(fragment);
  } catch (error) {
    message(error);
  } finally {
    loading = false;
    refresh.disabled = !active;
  }
}
async function loadNote(): Promise<void> {
  const expected = revision;
  try {
    const value = await callHost("read_note");
    if (typeof value !== "string") throw new Error("便笺读取失败，请点击刷新重试");
    if (!active || revision !== expected) return;
    note.value = value;
    noteLoaded = true;
    note.disabled = false;
    save.disabled = false;
  } catch (error) {
    message(error);
  }
}
save.addEventListener("click", () => {
  if (!active || saving || !noteLoaded) return;
  const value = note.value;
  const expected = revision;
  saving = true;
  save.disabled = true;
  void callHost("save_note", value)
    .then(() => {
      message(revision === expected ? "已保存" : "此前内容已保存，当前修改尚未保存");
    })
    .catch(message)
    .finally(() => {
      saving = false;
      save.disabled = !active || !noteLoaded;
    });
});
refresh.addEventListener("click", () => {
  void refreshInfo();
  if (!noteLoaded) void loadNote();
});
window.addEventListener("pagehide", () => {
  active = false;
  revision++;
});
window.addEventListener("pageshow", () => {
  active = true;
  save.disabled = saving || !noteLoaded;
  void refreshInfo();
  if (!noteLoaded) void loadNote();
});
void refreshInfo();
void loadNote();

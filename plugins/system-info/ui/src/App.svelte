<script lang="ts">
  import { onMount } from "svelte";
  import ActionButton from "@chord-control/ui/ActionButton.svelte";
  import Page from "@chord-control/ui/Page.svelte";
  import Notice from "@chord-control/ui/Notice.svelte";
  import Facts from "@chord-control/ui/Facts.svelte";
  import type { PluginCall } from "../../../../sdk/ui.ts";
  import { message, object } from "../../../../shared/validation.ts";

  let { call }: { call: PluginCall } = $props();
  let facts = $state.raw<Array<{ label: string; value: string }>>([]);
  let note = $state("");
  let noteLoaded = $state(false);
  let loading = $state(false);
  let reading = $state(false);
  let saving = $state(false);
  let infoError = $state("");
  let noteError = $state("");
  let status = $state("");
  let active = false;
  let revision = 0;

  async function refreshInfo() {
    if (!active || loading) return;
    loading = true;
    infoError = "";
    try {
      const value = await call("info");
      if (!object(value)) throw new Error("无法读取系统信息");
      if (!active) return;
      const labels = {
        hostname: "计算机名称",
        platform: "操作系统",
        arch: "架构",
        uptimeMinutes: "运行时间",
        memoryGiB: "内存",
      };
      facts = Object.entries(labels).map(([key, label]) => {
        const item = value[key];
        const text = typeof item === "string" || typeof item === "number" ? String(item) : "—";
        return {
          label,
          value:
            typeof item === "number" && key === "memoryGiB"
              ? `${item} GB`
              : typeof item === "number" && key === "uptimeMinutes"
                ? `${item} 分钟`
                : item === "win32"
                  ? "Windows"
                  : text,
        };
      });
    } catch (error) {
      if (active) infoError = message(error);
    } finally {
      if (active) loading = false;
    }
  }

  async function loadNote() {
    if (!active || reading || noteLoaded) return;
    const expected = revision;
    reading = true;
    noteError = "";
    try {
      const value = await call("read_note");
      if (typeof value !== "string") throw new Error("便笺读取失败，请重试");
      if (!active || revision !== expected) return;
      note = value;
      noteLoaded = true;
    } catch (error) {
      if (active) noteError = message(error);
    } finally {
      if (active) reading = false;
    }
  }

  async function saveNote() {
    if (!active || saving || !noteLoaded) return;
    const value = note;
    const expected = revision;
    saving = true;
    noteError = "";
    try {
      await call("save_note", value);
      if (active) status = revision === expected ? "已保存" : "此前内容已保存，当前修改尚未保存";
    } catch (error) {
      if (active) {
        noteError = message(error);
        status = "尚未保存";
      }
    } finally {
      if (active) saving = false;
    }
  }

  function visibleState() {
    return JSON.stringify({ facts, note, noteLoaded, infoError, noteError, status });
  }
  async function refresh() {
    const before = visibleState();
    await Promise.all([refreshInfo(), loadNote()]);
    const failed = Boolean(infoError || noteError);
    return { ok: !failed, visible: failed || before !== visibleState() };
  }
  onMount(() => {
    active = true;
    refresh();
    return () => {
      active = false;
      revision++;
    };
  });
</script>

<Page title="系统信息与便笺">
  {#snippet actions()}<ActionButton
      id="refresh"
      action={refresh}
      disabled={loading || reading}
      aria-busy={loading || reading}>刷新</ActionButton
    >{/snippet}
  <Facts id="info" live items={facts.length ? facts : [{ label: "系统信息", value: "暂无信息" }]} />
  {#if infoError}<Notice tone="error">{infoError}</Notice>{/if}
  <section aria-label="本机便笺">
    <label for="note">本机便笺（最多 10000 字符）</label>
    <textarea
      id="note"
      maxlength="10000"
      disabled={!noteLoaded}
      bind:value={note}
      oninput={() => {
        revision++;
        status = "尚未保存";
      }}></textarea>
    <div class="actions">
      <button id="save" disabled={!noteLoaded} aria-busy={saving} onclick={saveNote}
        >保存便笺</button
      >
      {#if !noteLoaded}<button aria-busy={reading} onclick={loadNote}>重试读取便笺</button>{/if}
    </div>
    <Notice id="status" tone={noteError ? "error" : "neutral"}>{noteError || status}</Notice>
  </section>
</Page>

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-block: 14px 12px;
  }
</style>

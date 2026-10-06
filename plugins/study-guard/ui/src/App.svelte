<script lang="ts">
  import { onMount } from "svelte";
  import Page from "@chord-control/ui/Page.svelte";
  import Notice from "@chord-control/ui/Notice.svelte";
  import type { PluginCall } from "../../../../sdk/ui.ts";
  import { message, object } from "../../../../shared/validation.ts";

  let { call }: { call: PluginCall } = $props();
  const browsers = [
    { id: "edge", name: "Microsoft Edge" },
    { id: "chrome", name: "Google Chrome" },
  ];
  let enabled = $state(false);
  let pending = $state.raw<string[]>([]);
  let busy = $state(true);
  let status = $state("正在读取保护状态…");
  let error = $state("");
  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function update(browser?: string) {
    if (!active || busy) return;
    busy = true;
    clearTimeout(timer);
    try {
      const value = await call(browser ? "open_browser" : "status", browser ?? null);
      if (
        !object(value) ||
        typeof value.active !== "boolean" ||
        !Array.isArray(value.pending) ||
        !value.pending.every((item) => typeof item === "string") ||
        typeof value.last !== "string"
      )
        throw new Error("保护状态读取失败，请稍后重试");
      if (!active) return;
      enabled = value.active;
      pending = value.pending as string[];
      error = "";
      status =
        browser && value.requested === true
          ? "请在密保盘中验证"
          : pending.length
            ? "正在等待密保盘验证"
            : value.last || (enabled ? "浏览器保护已启用" : "浏览器保护未启用");
    } catch (cause) {
      if (active) {
        error = message(cause);
        enabled = false;
      }
    } finally {
      if (active) {
        busy = false;
        timer = setTimeout(() => {
          void update();
        }, 1500);
      }
    }
  }

  onMount(() => {
    active = true;
    busy = false;
    void update();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  });
</script>

<Page
  title="浏览器保护"
  description="打开新的浏览器窗口前，请通过密保盘验证。已打开的浏览器可以继续使用。"
>
  <div class="browsers" role="group" aria-label="打开浏览器">
    {#each browsers as browser (browser.id)}
      <button
        data-browser={browser.id}
        disabled={busy || !enabled || pending.includes(browser.id)}
        onclick={() => update(browser.id)}
        >{browser.name}{pending.includes(browser.id) ? " · 等待验证" : ""}</button
      >
    {/each}
  </div>
  <Notice id="status" tone={error ? "error" : "neutral"}>{error || status}</Notice>
</Page>

<style>
  .browsers {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }
</style>

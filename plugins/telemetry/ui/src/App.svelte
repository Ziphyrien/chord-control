<script lang="ts">
  import { onMount } from "svelte";
  import Page from "@chord-control/ui/Page.svelte";
  import Notice from "@chord-control/ui/Notice.svelte";
  import Facts from "@chord-control/ui/Facts.svelte";
  import Disclosure from "@chord-control/ui/Disclosure.svelte";
  import type { PluginCall } from "../../../../sdk/ui.ts";
  import type { Json } from "../../../../shared/protocol.ts";
  import { message, object } from "../../../../shared/validation.ts";

  let { call }: { call: PluginCall } = $props();
  let status = $state.raw<Record<string, Json> | null>(null);
  let busy = $state(false);
  let reporting = $state(false);
  let error = $state("");
  let reportError = $state("");
  let notice = $state("正在读取上报状态…");
  let detail = $state<string | null>(null);
  let expanded = $state(false);
  let active = false;
  let awaitingSend = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function date(value: Json | undefined): string {
    if (typeof value !== "string") return "尚未上报";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString("zh-CN");
  }
  let facts = $derived(
    status
      ? [
          { label: "实时连接", value: status.connected ? "已连接" : "未连接" },
          {
            label: "上报状态",
            value: status.sending
              ? "上报进行中"
              : status.lastError
                ? "上次上报失败"
                : "等待下次上报",
          },
          {
            label: "上报间隔",
            value:
              typeof status.intervalSeconds === "number"
                ? `${status.intervalSeconds / 60} 分钟`
                : "—",
          },
          { label: "最近成功", value: date(status.lastSuccessAt) },
          {
            label: "成功上报",
            value: typeof status.succeeded === "number" ? `${status.succeeded} 次` : "—",
          },
          {
            label: "失败上报",
            value: typeof status.failed === "number" ? `${status.failed} 次` : "—",
          },
        ]
      : [],
  );

  async function refresh(method: "status" | "send" | "diagnose" = "status") {
    if (!active || busy) return;
    busy = true;
    clearTimeout(timer);
    error = "";
    notice = method === "status" ? "正在读取上报状态…" : "正在上报…";
    try {
      const value = await call(method);
      if (
        !object(value) ||
        typeof value.connected !== "boolean" ||
        typeof value.sending !== "boolean" ||
        !(value.lastError === null || typeof value.lastError === "string")
      )
        throw new Error("上报状态读取失败，请重试");
      if (!active) return;
      error = "";
      status = value;
      if (value.sending) {
        awaitingSend = true;
        notice = "上报进行中";
      } else if (value.lastError) {
        error = `上报失败：${value.lastError}`;
        notice = "";
        awaitingSend = false;
      } else {
        notice = awaitingSend || method !== "status" ? "上报成功" : "";
        awaitingSend = false;
      }
    } catch (cause) {
      if (active) {
        error = message(cause);
        notice = "";
      }
    } finally {
      if (active) {
        busy = false;
        if (awaitingSend)
          timer = setTimeout(() => {
            void refresh();
          }, 1500);
      }
    }
  }

  async function loadReport() {
    if (!active || reporting) return;
    reporting = true;
    reportError = "";
    try {
      const value = await call("report");
      if (!active) return;
      detail = value === null ? "暂无报告" : JSON.stringify(value, null, 2);
      expanded = true;
    } catch (cause) {
      if (active) reportError = message(cause);
    } finally {
      if (active) reporting = false;
    }
  }

  onMount(() => {
    active = true;
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  });
</script>

<Page
  title="运行遥测"
  description="定期仅上报运行摘要，不自动采集系统权限和审计。暂停此插件即可停止上报。"
>
  {#snippet actions()}<button disabled={busy} onclick={() => refresh()}
      >{busy ? "正在读取…" : "刷新"}</button
    >{/snippet}
  {#if status}<Facts items={facts} />{/if}
  <div class="actions">
    <button id="send" disabled={busy || status?.sending === true} onclick={() => refresh("send")}
      >{busy ? "请稍候…" : "立即上报"}</button
    >
    <button id="report" disabled={reporting} onclick={loadReport}
      >{reporting ? "正在读取…" : "查看最近报告"}</button
    >
  </div>
  <Notice id="status" tone={error ? "error" : notice === "上报成功" ? "success" : "neutral"}
    >{error || notice}</Notice
  >
  <Disclosure title="按需详细诊断">
    <p>
      仅排查故障时使用：会采集并上传进程身份、SID、UAC
      配置、注册表安全描述符及相关系统审计信息。常规上报和远端刷新不会触发此操作。
    </p>
    <button onclick={() => refresh("diagnose")} disabled={busy || status?.sending === true}>
      采集并上报详细诊断
    </button>
  </Disclosure>
  {#if reportError}<Notice tone="error">{reportError}</Notice>{/if}
  {#if detail !== null}
    <Disclosure title="最近报告 · 原始数据" bind:open={expanded}>
      <pre id="detail">{detail}</pre>
    </Disclosure>
  {/if}
</Page>

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
</style>

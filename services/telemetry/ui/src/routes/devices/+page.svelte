<script>
  import { resolve } from "$app/paths";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import Modal from "@chord-control/ui/Modal.svelte";
  import Select from "@chord-control/ui/Select.svelte";
  import { getTelemetry } from "$lib/context.js";
  import { date, deviceName } from "$lib/format.js";

  const telemetry = getTelemetry();
  let query = $derived(page.url.searchParams.get("q") ?? "");
  let filter = $state("all");
  let confirmation = $state.raw(null);
  let devices = $derived(
    (telemetry.state.list?.devices ?? []).filter(
      (device) => filter === "all" || device.trusted === (filter === "trusted"),
    ),
  );
  const filters = [
    { value: "all", label: "全部设备" },
    { value: "trusted", label: "已确认" },
    { value: "pending", label: "待确认" },
  ];
  async function search(event) {
    event.preventDefault();
    const url = new URL(page.url);
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    if (url.search === page.url.search) await telemetry.session.list(query);
    else await goto(resolve(`/devices${url.search}`));
  }
  function trust() {
    const device = confirmation;
    confirmation = null;
    void telemetry.session.setTrust(device.id, !device.trusted, device.label);
  }
</script>

<svelte:head><title>设备 · Chord</title></svelte:head>
<form id="search" class="toolbar" onsubmit={search}>
  <input
    id="query"
    type="search"
    placeholder="搜索用户名、计算机名或客户端ID"
    aria-label="搜索客户端"
    bind:value={query}
  />
  <button>刷新</button>
  <Select label="确认状态" items={filters} bind:value={filter} />
</form>
<p id="updated" class="muted">
  {#if telemetry.state.list}{telemetry.state.list.devices.length} 台客户端（最多显示100台） · {date(
      telemetry.state.list.receivedAt,
    )}{/if}
</p>
<div id="devices" aria-busy={telemetry.state.busy}>
  {#each devices as device (device.id)}
    <article class="device">
      <div>
        <strong>{deviceName(device)}</strong>
        <p>
          v{device.report.host.controller?.version ?? device.report.host.native?.version ?? "未知"} ·
          {device.ageSeconds > 900 ? "未收到近期上报" : "近期有上报"} · {date(device.lastSeen)}
        </p>
        <span class="badge">{device.trusted ? "已确认客户端" : "待确认客户端 · 尚未记录历史"}</span>
      </div>
      <a href={resolve(`/devices/${encodeURIComponent(device.id)}${page.url.search}`)}>查看</a>
      <button
        onclick={() => {
          confirmation = device;
        }}>{device.trusted ? "取消确认" : "确认此客户端"}</button
      >
    </article>
  {:else}
    <p>{telemetry.state.busy ? "正在读取…" : "尚未收到匹配客户端的上报。"}</p>
  {/each}
</div>
{#if confirmation}
  <Modal
    title={confirmation.trusted ? "取消确认" : "确认设备"}
    onclose={() => {
      confirmation = null;
    }}
  >
    {#snippet description()}
      <span>{deviceName(confirmation)}</span><br />
      <span
        >计算机：{confirmation.report.client.hostname} · 用户：{confirmation.report.client
          .username}</span
      ><br />
      <span>客户端 ID：{confirmation.id}</span><br />
      <span>{confirmation.trusted ? "取消后将只保留最新报告。" : "确认后保留7天历史报告。"}</span>
    {/snippet}
    <button onclick={trust}>确定</button>
    <button
      onclick={() => {
        confirmation = null;
      }}>返回</button
    >
  </Modal>
{/if}

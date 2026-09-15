<script lang="ts">
  import type { ControllerCommand, PluginStatus, PluginSummary } from "../../shared/protocol.ts";
  let {
    plugins,
    available,
    onopen,
    oncommand,
  }: {
    plugins: PluginSummary[];
    available: boolean;
    onopen: (plugin: PluginSummary) => Promise<void>;
    oncommand: (command: ControllerCommand) => Promise<boolean>;
  } = $props();
  const labels: Record<PluginStatus, string> = {
    active: "运行中",
    update: "可更新",
    paused: "已暂停",
    error: "异常",
    idle: "待安装",
  };
  let search = $state("");
  const filtered = $derived(
    plugins.filter((plugin) =>
      `${plugin.name} ${plugin.id}`.toLowerCase().includes(search.toLowerCase()),
    ),
  );
</script>

{#if plugins.length}
  <input
    class="search"
    type="search"
    aria-label="搜索插件"
    placeholder="搜索插件"
    bind:value={search}
  />
{/if}
<div class="plugin-list">
  {#each filtered as plugin (plugin.id)}
    <article class="plugin-row">
      <div class="plugin-info">
        <div class="plugin-heading">
          <h2>{plugin.name}</h2>
          <span class={["status", plugin.status]}>{labels[plugin.status]}</span><span
            class="version"
            >{plugin.version}{#if plugin.hasUpdate}
              → {plugin.latestVersion}{/if}</span
          >
        </div>
        {#if plugin.description}<p class="muted">{plugin.description}</p>{/if}
        {#if plugin.error}<p class="error">{plugin.error}</p>{/if}
      </div>
      <div class="actions">
        {#if plugin.hasUi}<button
            class="accent"
            disabled={!available}
            onclick={() => onopen(plugin)}>打开</button
          >{/if}
        {#if plugin.hasUpdate || !plugin.installed}<button
            disabled={!available}
            onclick={() => oncommand({ type: "install", pluginId: plugin.id })}
            >{plugin.installed ? "更新" : "安装"}</button
          >{/if}
        {#if plugin.installed}<button
            disabled={!available}
            onclick={() =>
              oncommand({ type: "set_enabled", pluginId: plugin.id, enabled: !plugin.enabled })}
            >{plugin.enabled ? "暂停" : "启动"}</button
          >{/if}
        <details class="plugin-menu">
          <summary aria-label={`${plugin.name}的更多操作`}>···</summary>
          <div>
            <button
              disabled={!available}
              onclick={() => oncommand({ type: "remove_plugin", pluginId: plugin.id })}>移除</button
            >
          </div>
        </details>
      </div>
    </article>
  {:else}<div class="empty">{plugins.length ? "没有匹配的插件" : "尚未添加插件"}</div>{/each}
</div>

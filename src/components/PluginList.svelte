<script lang="ts">
  import type { ControllerCommand, PluginSummary } from "../../shared/protocol.ts";
  import type { GroupConfirmation } from "../lib/session.ts";
  import { statusLabels } from "../lib/presentation.ts";
  let {
    plugins,
    available,
    pending,
    onopen,
    oncommand,
    onrequest,
  }: {
    plugins: PluginSummary[];
    available: boolean;
    pending?: string;
    onopen: (plugin: PluginSummary) => Promise<void>;
    oncommand: (command: ControllerCommand) => Promise<boolean>;
    onrequest: (plugin: PluginSummary, kind: GroupConfirmation["kind"]) => void;
  } = $props();
  let query = $state("");
  const filtered = $derived(
    plugins.filter((plugin) =>
      `${plugin.name} ${plugin.description} ${plugin.id}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    ),
  );
  const running = $derived(plugins.filter((plugin) => plugin.running).length);
</script>

<section aria-label="插件列表" aria-busy={!!pending}>
  <div class="list-toolbar">
    <p class="muted">{plugins.length} 个插件 · {running} 个运行中</p>
    {#if plugins.length}<label class="search"
        ><span class="sr-only">搜索插件</span><input
          type="search"
          placeholder="搜索插件"
          bind:value={query}
        /></label
      >{/if}
  </div>
  <div class="plugin-list">
    {#each filtered as plugin (plugin.id)}
      <article class="plugin-row" aria-label={plugin.name}>
        <div class="plugin-info">
          <div class="plugin-heading">
            <h2>{plugin.name}</h2>
            <span class={["status", plugin.status]}>{statusLabels[plugin.status]}</span>
          </div>
          {#if plugin.description}<p>{plugin.description}</p>{/if}
          <div class="plugin-meta">
            <span>{plugin.installed ? `v${plugin.version}` : "尚未安装"}</span>
            {#if plugin.hasUpdate && plugin.latestVersion}<span
                >可更新至 v{plugin.latestVersion}</span
              >{/if}
            {#if plugin.sourceStatus === "missing"}<span>来源已移除</span
              >{:else if plugin.sourceStatus === "detached"}<span>来自之前的插件来源</span>{/if}
          </div>
          {#if plugin.blockedReason}<p class="error">{plugin.blockedReason}</p>{/if}
          {#if plugin.error && plugin.error !== plugin.blockedReason}<p class="error">
              {plugin.error}
            </p>{/if}
        </div>
        <div class="actions plugin-actions">
          {#if plugin.hasUi}<button
              disabled={!available || !plugin.running}
              onclick={() => onopen(plugin)}>打开</button
            >{/if}
          {#if plugin.hasUpdate || !plugin.installed}<button
              disabled={!available ||
                plugin.sourceStatus === "missing" ||
                plugin.sourceStatus === "detached"}
              onclick={() => oncommand({ type: "install", pluginId: plugin.id })}
              >{plugin.installed ? "更新" : "安装"}</button
            >{/if}
          {#if plugin.installed}<button
              disabled={!available}
              onclick={() =>
                plugin.enabled
                  ? onrequest(plugin, "disable")
                  : oncommand({ type: "set_enabled", pluginId: plugin.id, enabled: true })}
              >{plugin.enabled ? "暂停" : "启动"}</button
            >{/if}
          {#if plugin.status !== "ignored"}<button
              class="text-button danger"
              disabled={!available}
              onclick={() => onrequest(plugin, "remove")}>忽略</button
            >{/if}
        </div>
      </article>
    {:else}
      <div class="empty">
        <h2>{plugins.length ? "没有匹配的插件" : "尚未添加插件"}</h2>
        <p>{plugins.length ? "试试其他名称，或清除搜索。" : "添加插件，让常用功能集中在这里。"}</p>
        {#if query}<button
            onclick={() => {
              query = "";
            }}>清除搜索</button
          >{/if}
      </div>
    {/each}
  </div>
</section>

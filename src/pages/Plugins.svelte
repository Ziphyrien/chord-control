<script lang="ts">
  import PluginList from "../components/PluginList.svelte";
  import { getWorkspace } from "../lib/workspace-context.ts";
  import { formatTime } from "../lib/presentation.ts";
  const { session, view, openAdd } = getWorkspace();
  const model = $derived(view.state);
  const available = $derived(
    model.connection === "online" && !model.pending.mutation && !model.pending.refresh,
  );
</script>

<header class="page-heading">
  <h1>插件</h1>
  <div class="actions">
    <button disabled={!available} onclick={() => session.run({ type: "check_updates" })}
      >{model.pending.mutation === "check_updates" ? "检查中…" : "检查更新"}</button
    >
    <button class="primary" disabled={!available} onclick={openAdd}>添加插件</button>
  </div>
</header>
{#if model.snapshot}
  <PluginList
    plugins={model.snapshot.plugins}
    {available}
    pending={model.pending.mutation}
    onopen={(plugin) => session.open(plugin)}
    oncommand={(command) => session.run(command)}
    onrequest={(plugin, kind) => session.requestChange(plugin, kind)}
  />
  {#if model.snapshot.checkedAt}<p class="muted footnote">
      上次检查 <time datetime={model.snapshot.checkedAt}
        >{formatTime(model.snapshot.checkedAt)}</time
      >
    </p>{/if}
{:else}
  <div class="empty">
    <h2>{model.connection === "loading" ? "正在载入插件" : "暂时无法显示插件"}</h2>
    <p>连接成功后，你的插件会显示在这里。</p>
  </div>
{/if}

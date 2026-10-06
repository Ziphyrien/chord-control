<script lang="ts">
  import ActionButton from "@chord-control/ui/ActionButton.svelte";
  import PluginList from "../components/PluginList.svelte";
  import { getWorkspace } from "../lib/workspace-context.ts";
  import { formatTime } from "../lib/presentation.ts";
  const { session, view, openAdd } = getWorkspace();
  const model = $derived(view.state);
  const available = $derived(model.connection !== "offline");
  async function checkUpdates() {
    const before = JSON.stringify({
      snapshot: session.state.snapshot,
      error: session.state.errors.mutation ?? "",
      notice: session.state.notice,
    });
    const ok = await session.run({ type: "check_updates" });
    const after = JSON.stringify({
      snapshot: session.state.snapshot,
      error: session.state.errors.mutation ?? "",
      notice: session.state.notice,
    });
    return { ok, visible: before !== after };
  }
</script>

<header class="page-heading">
  <h1>插件</h1>
  <div class="actions">
    <ActionButton action={checkUpdates} disabled={!available}>检查更新</ActionButton>
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
{:else if model.connection !== "loading"}
  <div class="empty">
    <h2>暂时无法显示插件</h2>
    <p>连接成功后，你的插件会显示在这里。</p>
  </div>
{/if}

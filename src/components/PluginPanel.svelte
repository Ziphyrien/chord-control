<script lang="ts">
  import type { PluginPanel } from "../lib/session.ts";
  let {
    panel,
    opening,
    onclose,
  }: { panel: PluginPanel | null; opening: string | null; onclose: () => void } = $props();
</script>

<section aria-label="插件界面">
  <header class="page-heading">
    <div>
      <p class="eyebrow">插件</p>
      <h1>{panel?.name ?? opening}</h1>
    </div>
    <button onclick={onclose}>返回插件</button>
  </header>
  {#if panel}
    {#key `${panel.pluginId}:${panel.revision}:${panel.url}`}
      <iframe
        class="plugin-frame"
        title={panel.name}
        src={panel.url}
        sandbox="allow-scripts allow-forms allow-downloads"
        referrerpolicy="no-referrer"
      ></iframe>
    {/key}
  {:else}<div class="empty" role="status">
      <h2>正在打开插件…</h2>
      <p>稍候即可使用，也可以返回插件列表。</p>
    </div>{/if}
</section>

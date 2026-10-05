<script lang="ts">
  import type { PluginPanel } from "../lib/session.ts";
  let { panel, onclose }: { panel: PluginPanel; onclose: () => void } = $props();
</script>

<section aria-label="插件界面">
  <header class="page-heading">
    <div>
      <p class="eyebrow">插件</p>
      <h1>{panel.name}</h1>
    </div>
    <button onclick={onclose}>返回插件</button>
  </header>
  {#key `${panel.pluginId}:${panel.revision}:${panel.url}`}
    <iframe
      class="plugin-frame"
      title={panel.name}
      src={panel.url}
      sandbox="allow-scripts allow-forms allow-downloads"
      referrerpolicy="no-referrer"
    ></iframe>
  {/key}
</section>

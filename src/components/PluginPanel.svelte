<script lang="ts">
  let { panel, onclose }: { panel: { name: string; url: string }; onclose: () => void } = $props();
</script>

<header class="page-heading">
  <h1>{panel.name}</h1>
  <button onclick={onclose}>返回插件</button>
</header>
<iframe
  class="plugin-frame"
  title={panel.name}
  src={panel.url}
  sandbox="allow-scripts allow-forms allow-downloads"
  referrerpolicy="no-referrer"
></iframe>

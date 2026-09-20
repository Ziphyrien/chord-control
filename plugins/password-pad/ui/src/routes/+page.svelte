<script lang="ts">
  import "@chord-control/ui/theme.css";
  import PluginPage from "../../../../../sdk/PluginPage.svelte";
  import App from "../App.svelte";
  import type { PluginCall } from "../../../../../sdk/ui.ts";
  import type { PluginSurface } from "../../../../../shared/protocol.ts";
</script>

<svelte:head><title>密保盘</title></svelte:head>

<PluginPage>
  {#snippet children(call: PluginCall, surface: PluginSurface)}
    <App {call} {surface} />
  {/snippet}
</PluginPage>

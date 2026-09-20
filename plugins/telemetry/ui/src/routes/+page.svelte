<script lang="ts">
  import "@chord-control/ui/theme.css";
  import PluginPage from "../../../../../sdk/PluginPage.svelte";
  import App from "../App.svelte";
  import type { PluginCall } from "../../../../../sdk/ui.ts";
</script>

<svelte:head><title>运行遥测</title></svelte:head>

<PluginPage>
  {#snippet children(call: PluginCall)}
    <App {call} />
  {/snippet}
</PluginPage>

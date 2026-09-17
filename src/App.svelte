<script lang="ts">
  import type { ControllerClient } from "./lib/controller.ts";
  import { unavailableClient } from "./lib/controller.ts";
  import { browserDesktop, type DesktopAdapter } from "./lib/desktop.ts";
  import { ControllerSession } from "./lib/session.ts";
  import Workspace from "./components/Workspace.svelte";

  let {
    client = unavailableClient,
    desktop = browserDesktop,
  }: { client?: ControllerClient; desktop?: DesktopAdapter } = $props();
  const session = $derived(new ControllerSession(client, desktop));
</script>

<svelte:head><title>Chord Control</title></svelte:head>
{#key session}<Workspace {session} />{/key}

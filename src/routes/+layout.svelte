<script lang="ts">
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import { afterNavigate, goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import Workspace from "../components/Workspace.svelte";
  import { ControllerSession } from "../lib/session.ts";
  import { createPlatform } from "$platform";
  import "../app.css";

  let { children }: { children: Snippet } = $props();
  const { client, desktop } = createPlatform();
  const session = new ControllerSession(client, desktop);
  afterNavigate(() => session.closePanel());
</script>

<svelte:head><title>Chord Control</title></svelte:head>
<Workspace
  {session}
  currentPath={page.url.pathname}
  onnavigate={(path) => {
    void goto(resolve(path));
  }}
  {children}
/>

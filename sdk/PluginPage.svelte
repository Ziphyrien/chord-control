<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { createPluginCall, type PluginCall } from "./ui.ts";
  import type { PluginSurface } from "../shared/protocol.ts";

  let { children }: { children: Snippet<[PluginCall, PluginSurface]> } = $props();
  let session = $state.raw<{
    lifetime: AbortController;
    call: PluginCall;
    surface: PluginSurface;
  }>();

  function surface(): PluginSurface {
    return location.hash === "#panel" ? "panel" : "window";
  }

  function start() {
    if (session) return;
    const lifetime = new AbortController();
    session = {
      lifetime,
      call: createPluginCall({ endpoint: new URL("rpc", location.href), signal: lifetime.signal }),
      surface: surface(),
    };
  }

  function stop() {
    session?.lifetime.abort();
    session = undefined;
  }

  function changeSurface() {
    if (session && session.surface !== surface()) {
      stop();
      start();
    }
  }

  onMount(() => {
    start();
    return stop;
  });
</script>

<svelte:window onpagehide={stop} onpageshow={start} onhashchange={changeSurface} />

<div id="app">
  {#if session}
    {#key session}
      {@render children(session.call, session.surface)}
    {/key}
  {/if}
</div>

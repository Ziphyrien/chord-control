<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    id,
    tone = "neutral",
    children,
  }: {
    id?: string;
    tone?: "neutral" | "success" | "error";
    children: Snippet;
  } = $props();
</script>

<div {id} class={["notice", tone]} role={tone === "error" ? "alert" : "status"} aria-atomic="true">
  {@render children()}
</div>

<style>
  .notice {
    min-height: 1.6em;
    color: var(--cc-muted, #626964);
    font: var(--cc-font, 15px/1.6 system-ui, sans-serif);
    overflow-wrap: anywhere;
  }
  .success {
    color: var(--cc-success, #356045);
  }
  .error {
    color: var(--cc-danger, #a02d28);
  }
</style>

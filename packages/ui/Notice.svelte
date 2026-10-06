<script lang="ts">
  import "./palette.css";
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

<div
  {id}
  class="cc-notice"
  data-tone={tone}
  role={tone === "error" ? "alert" : "status"}
  aria-atomic="true"
>
  {@render children()}
</div>

<style>
  .cc-notice {
    min-height: 1.6em;
    color: var(--cc-muted);
    font: var(--cc-font, 15px/1.6 system-ui, sans-serif);
    overflow-wrap: anywhere;
  }
  .cc-notice[data-tone="success"] {
    color: var(--cc-success);
  }
  .cc-notice[data-tone="error"] {
    color: var(--cc-danger);
  }
</style>

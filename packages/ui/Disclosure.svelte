<script lang="ts">
  import { Collapsible } from "bits-ui";
  import type { Snippet } from "svelte";

  let {
    title,
    children,
    open = $bindable(false),
  }: {
    title: string;
    children: Snippet;
    open?: boolean;
  } = $props();
</script>

<Collapsible.Root bind:open class="cc-disclosure">
  <Collapsible.Trigger class="cc-disclosure-trigger">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={open ? "m4 6 4 4 4-4" : "m6 4 4 4-4 4"} stroke="currentColor" stroke-width="1.5" />
    </svg>
    <span>{title}</span>
  </Collapsible.Trigger>
  <Collapsible.Content class="cc-disclosure-content">
    {@render children()}
  </Collapsible.Content>
</Collapsible.Root>

<style>
  :global(.cc-disclosure) {
    min-width: 0;
    color: var(--cc-text, #272b29);
    font: var(--cc-font, 15px/1.6 system-ui, "Segoe UI", sans-serif);
  }
  :global(button.cc-disclosure-trigger) {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    min-height: 38px;
    padding: 8px;
    border: 1px solid transparent;
    border-radius: var(--cc-radius, 10px);
    background: transparent;
    color: var(--cc-muted, #626964);
    font: inherit;
    text-align: start;
    overflow-wrap: anywhere;
    cursor: pointer;
  }
  :global(button.cc-disclosure-trigger:hover) {
    background: var(--cc-accent, #e7eee7);
    border-color: var(--cc-focus, #476c53);
  }
  :global(.cc-disclosure-trigger:focus-visible) {
    outline: 2px solid var(--cc-focus, #476c53);
    outline-offset: 3px;
  }
  svg {
    flex-shrink: 0;
  }
  :global(.cc-disclosure-content) {
    overflow-wrap: anywhere;
  }
</style>

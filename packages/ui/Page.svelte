<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    titleId,
    description,
    actions,
    children,
  }: {
    title: string;
    titleId?: string;
    description?: string;
    actions?: Snippet;
    children: Snippet;
  } = $props();
</script>

<main class="cc-page">
  <header>
    <div>
      <h1 id={titleId}>{title}</h1>
      {#if description}<p>{description}</p>{/if}
    </div>
    {#if actions}<div class="cc-page-actions">{@render actions()}</div>{/if}
  </header>
  <div class="cc-page-content">{@render children()}</div>
</main>

<style>
  main {
    box-sizing: border-box;
    width: 100%;
    max-width: var(--cc-page-width, 720px);
    margin-inline: auto;
    padding: clamp(20px, 5vw, 40px);
    color: var(--cc-text, #272b29);
    font: var(--cc-font, 15px/1.6 system-ui, sans-serif);
  }
  header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 20px;
    flex-wrap: wrap;
    margin-bottom: 24px;
  }
  h1 {
    margin: 0;
    font-size: 24px;
    font-weight: 600;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  p {
    margin: 10px 0 0;
    color: var(--cc-muted, #626964);
  }
  .cc-page-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .cc-page-content {
    display: grid;
    gap: 20px;
  }
</style>

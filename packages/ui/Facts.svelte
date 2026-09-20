<script lang="ts">
  let {
    id,
    items,
    live = false,
  }: {
    id?: string;
    items: ReadonlyArray<{ label: string; value: string | number }>;
    live?: boolean;
  } = $props();
</script>

<dl {id} aria-live={live ? "polite" : undefined}>
  {#each items as item (item.label)}
    <div>
      <dt>{item.label}</dt>
      <dd>{item.value}</dd>
    </div>
  {/each}
</dl>

<style>
  dl {
    margin: 0;
    padding: 4px 20px;
    border: 1px solid var(--cc-border, #daddd9);
    border-radius: var(--cc-radius, 10px);
    background: var(--cc-surface, #fff);
    color: var(--cc-text, #272b29);
    font: var(--cc-font, 15px/1.6 system-ui, sans-serif);
  }
  div {
    display: grid;
    grid-template-columns: minmax(100px, 1fr) minmax(0, 2fr);
    gap: 12px;
    padding-block: 12px;
  }
  div + div {
    border-top: 1px solid var(--cc-border, #daddd9);
  }
  dt {
    color: var(--cc-muted, #626964);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  @media (max-width: 360px) {
    div {
      grid-template-columns: 1fr;
      gap: 4px;
    }
  }
</style>

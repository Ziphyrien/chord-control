<script lang="ts">
  import { Select } from "bits-ui";

  let {
    label,
    items,
    value = $bindable(""),
  }: {
    label: string;
    items: { value: string; label: string }[];
    value?: string;
  } = $props();

  const selectedLabel = $derived(items.find((item) => item.value === value)?.label ?? label);
</script>

<Select.Root type="single" bind:value {items} allowDeselect={false}>
  <Select.Trigger class="cc-select-trigger" aria-label={label}>
    <span class="label">{selectedLabel}</span>
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" />
    </svg>
  </Select.Trigger>
  <Select.Portal>
    <Select.Content class="cc-select-menu" align="end" sideOffset={6}>
      <Select.Viewport>
        {#each items as item (item.value)}
          <Select.Item class="cc-select-option" value={item.value} label={item.label}>
            {#snippet children({ selected })}
              <span>{item.label}</span>
              <span class="check" aria-hidden="true">{selected ? "✓" : ""}</span>
            {/snippet}
          </Select.Item>
        {/each}
      </Select.Viewport>
    </Select.Content>
  </Select.Portal>
</Select.Root>

<style>
  :global(button.cc-select-trigger) {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-width: 148px;
    max-width: 100%;
    min-height: 38px;
    padding: 8px 14px;
    border: 1px solid var(--cc-border, #daddd9);
    border-radius: var(--cc-radius, 10px);
    background: var(--cc-control-surface, var(--cc-surface, #fff));
    color: var(--cc-text, #272b29);
    font: var(--cc-font, 15px/1.6 system-ui, "Segoe UI", sans-serif);
    cursor: pointer;
  }
  :global(button.cc-select-trigger:hover) {
    background: var(--cc-accent, #e7eee7);
    border-color: var(--cc-focus, #476c53);
  }
  :global(.cc-select-trigger:focus-visible) {
    outline: 2px solid var(--cc-focus, #476c53);
    outline-offset: 3px;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  svg {
    flex-shrink: 0;
  }
  :global(.cc-select-menu) {
    box-sizing: border-box;
    z-index: var(--cc-popover-layer, 40);
    min-width: min(180px, var(--bits-select-content-available-width));
    max-width: var(--bits-select-content-available-width);
    max-height: var(--bits-select-content-available-height);
    overflow-y: auto;
    padding: 4px;
    border: 1px solid var(--cc-border, #daddd9);
    border-radius: var(--cc-radius, 10px);
    background: var(--cc-surface, #fff);
    color: var(--cc-text, #272b29);
    font: var(--cc-font, 15px/1.6 system-ui, "Segoe UI", sans-serif);
    box-shadow: var(--cc-popover-shadow, 0 8px 24px #0005);
  }
  :global(.cc-select-option) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 9px 12px;
    border-radius: 4px;
    cursor: pointer;
    outline: none;
    overflow-wrap: anywhere;
  }
  :global(.cc-select-option[data-highlighted]) {
    background: var(--cc-accent, #e7eee7);
  }
  .check {
    flex: 0 0 16px;
    color: var(--cc-focus, #476c53);
  }
</style>

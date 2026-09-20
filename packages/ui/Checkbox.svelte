<script lang="ts">
  import { Checkbox } from "bits-ui";

  const uid = $props.id();
  let {
    id = uid,
    label,
    checked = $bindable(false),
    disabled = false,
  }: {
    id?: string;
    label: string;
    checked?: boolean;
    disabled?: boolean;
  } = $props();
</script>

<div class="cc-checkbox">
  <Checkbox.Root
    {id}
    {disabled}
    type="button"
    class="cc-checkbox-control"
    bind:checked={() => checked, (value) => (checked = value)}
  >
    {#snippet children({ checked })}
      {#if checked}
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" stroke-width="2" />
        </svg>
      {/if}
    {/snippet}
  </Checkbox.Root>
  <label for={id}>{label}</label>
</div>

<style>
  .cc-checkbox {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 24px;
    color: var(--cc-text, #272b29);
    font: var(--cc-font, 15px/1.6 system-ui, "Segoe UI", sans-serif);
    font-size: 13px;
  }
  .cc-checkbox label {
    margin: 0;
  }
  :global(button.cc-checkbox-control) {
    box-sizing: border-box;
    display: inline-grid;
    place-items: center;
    flex-shrink: 0;
    width: 19px;
    height: 19px;
    min-height: 19px;
    padding: 0;
    border: 1px solid var(--cc-border, #daddd9);
    border-radius: 3px;
    color: var(--cc-text, #272b29);
    background: var(--cc-control-surface, var(--cc-surface, #fff));
    cursor: pointer;
  }
  :global(button.cc-checkbox-control:hover:not(:disabled)) {
    background: var(--cc-control-surface, var(--cc-surface, #fff));
    border-color: var(--cc-focus, #476c53);
  }
  :global(button.cc-checkbox-control[data-state="checked"]),
  :global(button.cc-checkbox-control[data-state="checked"]:hover:not(:disabled)) {
    color: var(--cc-checked-text, var(--cc-surface, #fff));
    background: var(--cc-focus, #476c53);
    border-color: var(--cc-focus, #476c53);
  }
  :global(button.cc-checkbox-control:focus-visible) {
    outline: 2px solid var(--cc-focus, #476c53);
    outline-offset: 3px;
  }
  :global(button.cc-checkbox-control:disabled) {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>

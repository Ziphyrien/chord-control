<script lang="ts">
  import "./palette.css";
  import { Switch } from "bits-ui";

  let {
    id,
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

<Switch.Root
  {id}
  {disabled}
  type="button"
  class="cc-switch"
  aria-label={label}
  bind:checked={() => checked, (value) => (checked = value)}
>
  <Switch.Thumb class="cc-switch-thumb" />
</Switch.Root>

<style>
  :global(button.cc-switch) {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    width: 42px;
    height: 24px;
    min-height: 24px;
    padding: 3px;
    border: 1px solid var(--cc-border);
    border-radius: 999px;
    background: var(--cc-switch-track);
    cursor: pointer;
  }
  :global(button.cc-switch:hover:not(:disabled)) {
    background: var(--cc-switch-track);
    border-color: var(--cc-focus);
  }
  :global(button.cc-switch[data-state="checked"]),
  :global(button.cc-switch[data-state="checked"]:hover:not(:disabled)) {
    background: var(--cc-fill);
    border-color: var(--cc-fill);
  }
  :global(button.cc-switch:focus-visible) {
    outline: 2px solid var(--cc-focus);
    outline-offset: 3px;
  }
  :global(button.cc-switch:disabled) {
    opacity: 0.45;
    cursor: not-allowed;
  }
  :global(.cc-switch-thumb) {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--cc-switch-thumb);
    transform: translateX(0);
  }
  :global(.cc-switch-thumb[data-state="checked"]) {
    background: var(--cc-on-fill);
    transform: translateX(18px);
  }
</style>

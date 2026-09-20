# Shared UI

Portable Svelte 5 components. This package depends on Svelte and Bits UI and has no application, transport, or runtime integration.

Import components through their explicit package paths:

```svelte
<script lang="ts">
  import Modal from "@chord-control/ui/Modal.svelte";
  import Select from "@chord-control/ui/Select.svelte";
  import Disclosure from "@chord-control/ui/Disclosure.svelte";
  import Checkbox from "@chord-control/ui/Checkbox.svelte";
  import Switch from "@chord-control/ui/Switch.svelte";

  let showing = $state(false);
  let value = $state("all");
  let open = $state(false);
  const items = [{ value: "all", label: "All events" }];
</script>

<button onclick={() => (showing = true)}>Preferences</button>
<Select label="Filter events" {items} bind:value />
<Disclosure title="Report" bind:open>Report contents</Disclosure>
{#if showing}
  <Modal title="Preferences" onclose={() => (showing = false)}>
    {#snippet description()}Choose which events to display.{/snippet}
    <Select label="Dialog filter" {items} bind:value />
  </Modal>
{/if}
```

`Modal` is open while mounted. Its required props are `title: string`, `description: Snippet`, `children: Snippet`, and `onclose: () => void`. The caller removes it when `onclose` runs. Bits UI owns focus trapping, Escape, and outside interaction; the wrapper restores focus to the opener when it is still connected.

`Select` accepts `label: string`, `items: { value: string; label: string }[]`, and bindable `value: string` (default `""`). Item values must be unique. The label is its accessible name and its placeholder when no item matches. The current item cannot be deselected by choosing it again.

`Disclosure` accepts `title: string`, `children: Snippet`, and bindable `open: boolean` (default `false`). Bits Collapsible owns keyboard interaction and expanded state semantics.

`Checkbox` and `Switch` accept `label: string`, optional `id: string`, `disabled: boolean` (default `false`), and bindable `checked: boolean` (default `false`). Checkbox renders a visible associated label; Switch uses `label` as its accessible name and supports an external visible `<label for={id}>`. Both explicitly render `type="button"` so toggling inside a form never submits it.

Use `bind:checked` for local state. For an externally controlled operation, use a function binding: its setter requests the change, and its getter continues to supply the confirmed state. The wrapper does not optimistically change that state:

```svelte
<Checkbox label="Automatic updates" bind:checked={automaticUpdates} />
<Switch
  id="startup"
  label="Start at login"
  bind:checked={() => enabled, (next) => requestChange(next)}
  disabled={pending}
/>
```

Checked controls use `--cc-focus` for their background. `--cc-checked-text` overrides the checkbox checkmark color (defaults to `--cc-surface`), and `--cc-switch-track` and `--cc-switch-thumb` override the switch's unchecked track and thumb colors.

`Page.svelte`, `Notice.svelte`, and `Facts.svelte` remain available at their existing package paths.

## Styling

Interactive components carry their own namespaced CSS and light defaults, even without importing `theme.css`. Import `@chord-control/ui/theme.css` once in an application's root layout when its page, typography, and form defaults are desired. Desktop imports `@chord-control/ui/palette.css` with its own layout styles. The palette defaults to light; add `data-cc-theme="dark"` to the document element for the dark palette.

Colors are generated from four seed colors using perceptual OKLCH hue/chroma adjustment and APCA against the actual surface colors. Edit the repository’s `scripts/generate-palette.mjs`, then run `vp run theme:generate` from the repository root. `theme:check` verifies the committed CSS and 24 text/background pairs (body text Lc ≥ 90, secondary text and filled controls Lc ≥ 75). These are design targets, not a WCAG certification. Color libraries are development dependencies and do not ship in browser bundles.

Override `--cc-surface`, `--cc-control-surface`, `--cc-text`, `--cc-muted`, `--cc-border`, `--cc-accent` (highlight background), `--cc-focus`, `--cc-radius`, and `--cc-font` to customize interactive components. `--cc-overlay`, `--cc-modal-shadow`, and `--cc-popover-shadow` customize overlays and shadows. Put shared theme overrides on `:root` or `body`: dialog and select content are portaled to `body`, outside the invoking component's ancestors.

`--cc-modal-layer` defaults to `30`; dialog content sits one level higher. `--cc-popover-layer` defaults to `40`, allowing a select menu inside a dialog to remain visible above it. Keep that ordering if overriding these tokens.

## Browser checks

From the workspace root, run `bunx vp test packages/ui/tests/interactive.test.mjs`. The probe bundles an isolated fixture in memory and uses Playwright Chromium to cover two-way bindings, pending externally controlled switch state, checkbox keyboard interaction and form non-submission, disabled controls, keyboard selection and disclosure, focus trapping/restoration, all modal dismissal paths, nested select layering, theme overrides, and a narrow viewport. It does not use desktop or SvelteKit configuration, nor write build artifacts.

<script lang="ts">
  import { Dialog } from "bits-ui";
  import type { Snippet } from "svelte";

  let {
    title,
    description,
    children,
    onclose,
  }: {
    title: string;
    description: Snippet;
    children: Snippet;
    onclose: () => void;
  } = $props();

  // The caller mounts the modal after opening it, without a Dialog.Trigger.
  const opener =
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
</script>

<Dialog.Root
  open
  onOpenChange={(open) => {
    if (!open) onclose();
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="cc-modal-overlay" />
    <Dialog.Content
      class="cc-modal"
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (opener?.isConnected) opener.focus();
      }}
    >
      <div class="cc-modal-heading">
        <Dialog.Title class="cc-modal-title" level={2}>{title}</Dialog.Title>
        <Dialog.Close class="cc-modal-close" aria-label={`关闭${title}`}>关闭</Dialog.Close>
      </div>
      <Dialog.Description class="cc-modal-description">{@render description()}</Dialog.Description>
      {@render children()}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.cc-modal-overlay) {
    position: fixed;
    inset: 0;
    z-index: var(--cc-modal-layer, 30);
    background: var(--cc-overlay, #060c09b8);
  }
  :global(.cc-modal) {
    box-sizing: border-box;
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: calc(var(--cc-modal-layer, 30) + 1);
    transform: translate(-50%, -50%);
    width: min(520px, calc(100% - 32px));
    max-height: calc(100dvh - 48px);
    overflow: auto;
    padding: 28px;
    border: 1px solid var(--cc-border, #daddd9);
    border-radius: var(--cc-radius, 10px);
    color: var(--cc-text, #272b29);
    background: var(--cc-surface, #fff);
    font: var(--cc-font, 15px/1.6 system-ui, "Segoe UI", sans-serif);
    box-shadow: var(--cc-modal-shadow, 0 24px 90px #0006);
  }
  .cc-modal-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  :global(.cc-modal-title) {
    margin: 0;
    font-size: 21px;
    font-weight: 600;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  :global(.cc-modal-description) {
    margin: 14px 0;
    color: var(--cc-muted, #626964);
    font-size: 14px;
    line-height: 1.65;
    overflow-wrap: anywhere;
  }
  :global(button.cc-modal-close) {
    flex-shrink: 0;
    min-height: 38px;
    padding: 8px 14px;
    border: 1px solid transparent;
    border-radius: var(--cc-radius, 10px);
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  :global(button.cc-modal-close:hover) {
    background: var(--cc-accent, #e7eee7);
    border-color: var(--cc-focus, #476c53);
  }
  :global(.cc-modal-close:focus-visible) {
    outline: 2px solid var(--cc-focus, #476c53);
    outline-offset: 3px;
  }
  @media (max-width: 640px) {
    :global(.cc-modal) {
      padding: 22px;
    }
  }
</style>

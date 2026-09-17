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
    <Dialog.Overlay class="modal-overlay" />
    <Dialog.Content
      class="modal"
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (opener?.isConnected) opener.focus();
      }}
    >
      <div class="dialog-heading">
        <Dialog.Title level={2}>{title}</Dialog.Title>
        <Dialog.Close class="text-button" aria-label={`关闭${title}`}>关闭</Dialog.Close>
      </div>
      <Dialog.Description class="modal-description">{@render description()}</Dialog.Description>
      {@render children()}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

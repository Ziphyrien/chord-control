<script lang="ts">
  import type { GroupConfirmation } from "../lib/session.ts";
  import Modal from "./Modal.svelte";
  let {
    confirmation,
    busy,
    available,
    error,
    onclose,
    onconfirm,
  }: {
    confirmation: GroupConfirmation;
    busy: boolean;
    available: boolean;
    error: string;
    onclose: () => void;
    onconfirm: () => Promise<void>;
  } = $props();
  const removing = $derived(confirmation.kind === "remove");
</script>

<Modal title={`${removing ? "移除" : "暂停"}「${confirmation.name}」？`} {onclose}>
  {#snippet description()}
    {removing ? "移除后保留插件数据。" : "暂停后保留插件安装和数据。"}
    {#if confirmation.dependents.length}
      以下插件会一并暂停，安装和数据会保留。
    {/if}
  {/snippet}
  {#if confirmation.dependents.length}<ul class="affected-list" aria-label="一并暂停的插件">
      {#each confirmation.dependents as plugin (plugin.id)}<li>{plugin.name}</li>{/each}
    </ul>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>
    <p class="muted">请核对当前名单后再次确认。</p>{/if}
  <div class="actions dialog-actions">
    <button type="button" onclick={onclose}>取消</button><button
      type="button"
      class="primary"
      disabled={!available || busy}
      onclick={onconfirm}
      >{busy
        ? "处理中…"
        : confirmation.needsRefresh
          ? "刷新名单"
          : removing
            ? "确认移除"
            : "确认暂停"}</button
    >
  </div>
</Modal>

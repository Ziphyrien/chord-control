<script lang="ts">
  import Modal from "./Modal.svelte";
  let {
    busy,
    available,
    error,
    onclose,
    onsubmit,
  }: {
    busy: boolean;
    available: boolean;
    error: string;
    onclose: () => void;
    onsubmit: (url: string, publicKey: string) => Promise<void>;
  } = $props();
  let url = $state("");
  let publicKey = $state("");
</script>

<Modal title="添加插件" {onclose}>
  {#snippet description()}填写发布者提供的插件地址和公钥。{/snippet}
  <form
    onsubmit={(event) => {
      event.preventDefault();
      if (available && !busy) void onsubmit(url.trim(), publicKey.trim());
    }}
    aria-busy={busy}
  >
    <fieldset disabled={!available || busy}>
      <label class="field"
        >插件地址<input
          type="url"
          required
          bind:value={url}
          placeholder="https://…/plugin.json"
          spellcheck="false"
        /></label
      >
      <label class="field"
        >发布者公钥<textarea rows="4" required bind:value={publicKey} spellcheck="false"
        ></textarea></label
      >
    </fieldset>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="actions dialog-actions">
      <button type="button" onclick={onclose}>{busy ? "关闭" : "取消"}</button><button
        class="primary"
        type="submit"
        disabled={!available || busy}>{busy ? "正在安装…" : "安装"}</button
      >
    </div>
  </form>
</Modal>

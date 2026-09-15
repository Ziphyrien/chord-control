<script lang="ts">
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

<dialog
  aria-labelledby="add-title"
  {@attach (element) => {
    element.showModal();
  }}
  {onclose}
>
  <h2 id="add-title">添加插件</h2>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void onsubmit(url.trim(), publicKey.trim());
    }}
  >
    <label class="field"
      >插件地址<input
        type="url"
        required
        bind:value={url}
        placeholder="https://github.com/…/plugin.json"
      /></label
    >
    <label class="field"
      >发布者公钥<textarea
        rows="4"
        required
        bind:value={publicKey}
        placeholder="-----BEGIN PUBLIC KEY-----"></textarea></label
    >
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="actions dialog-actions">
      <button type="button" onclick={onclose}>取消</button><button
        class="primary"
        type="submit"
        disabled={!available}>{busy ? "安装中…" : "安装"}</button
      >
    </div>
  </form>
</dialog>

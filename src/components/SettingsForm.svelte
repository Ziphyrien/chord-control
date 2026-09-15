<script lang="ts">
  import { untrack } from "svelte";
  import type { ControllerSettings } from "../../shared/protocol.ts";
  let {
    settings,
    available,
    autostart,
    dataDir,
    onsave,
    ontoggle,
    onopen,
  }: {
    settings: ControllerSettings;
    available: boolean;
    autostart: boolean;
    dataDir: string;
    onsave: (value: ControllerSettings) => Promise<boolean>;
    ontoggle: () => Promise<void>;
    onopen: () => Promise<void>;
  } = $props();
  // The parent keys this form by saved settings; background status updates keep edits intact.
  let draft = $state<ControllerSettings>(untrack(() => ({ ...settings })));
</script>

<div class="settings">
  <div class="setting-row">
    <label for="autostart">登录时自动启动</label><input
      id="autostart"
      type="checkbox"
      role="switch"
      checked={autostart}
      disabled={!available}
      onchange={ontoggle}
    />
  </div>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void onsave($state.snapshot(draft));
    }}
  >
    <label class="field"
      >检查间隔（分钟）<input
        type="number"
        min="1"
        max="1440"
        required
        bind:value={draft.checkIntervalMinutes}
      /></label
    >
    <label class="checkbox"
      ><input type="checkbox" bind:checked={draft.autoUpdate} />自动安装新增插件和更新</label
    >
    <label class="field"
      >插件目录地址<input
        type="url"
        bind:value={draft.catalogUrl}
        placeholder="https://github.com/…/catalog.json"
      /></label
    >
    <label class="field"
      >发布者公钥<textarea
        rows="4"
        bind:value={draft.catalogPublicKey}
        placeholder="-----BEGIN PUBLIC KEY-----"></textarea></label
    >
    <button class="primary" type="submit" disabled={!available}>保存</button>
  </form>
  {#if dataDir}<div class="setting-row data-directory">
      <div>
        数据目录
        <p class="muted">{dataDir}</p>
      </div>
      <button disabled={!available} onclick={onopen}>打开文件夹</button>
    </div>{/if}
</div>

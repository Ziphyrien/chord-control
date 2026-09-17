<script lang="ts">
  import { Switch } from "bits-ui";
  import type { ControllerSettings } from "../../shared/protocol.ts";
  import { parseSettings } from "../../shared/commands.ts";
  let {
    settings,
    available,
    saving,
    desktopAvailable,
    autostart,
    autostartBusy,
    directoryBusy,
    dataDir,
    onsave,
    ontoggle,
    onopen,
  }: {
    settings: ControllerSettings;
    available: boolean;
    saving: boolean;
    desktopAvailable: boolean;
    autostart: boolean | null;
    autostartBusy: boolean;
    directoryBusy: boolean;
    dataDir: string;
    onsave: (settings: ControllerSettings) => Promise<boolean>;
    ontoggle: () => Promise<void>;
    onopen: () => Promise<void>;
  } = $props();
  let edits = $state<ControllerSettings | null>(null);
  let error = $state("");
  const draft = $derived(edits ?? settings);
  function update(patch: Partial<ControllerSettings>) {
    edits = { ...draft, ...patch };
    error = "";
  }
  async function save() {
    if (!available) return;
    try {
      const value = parseSettings(draft);
      if (await onsave(value)) edits = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
</script>

<div class="settings">
  <section class="settings-section" aria-labelledby="general-title">
    <h2 id="general-title">常规</h2>
    <div class="setting-row">
      <div>
        <label for="autostart">登录时自动启动</label>
      </div>
      <Switch.Root
        id="autostart"
        class="switch"
        bind:checked={
          () => autostart ?? false,
          () => {
            void ontoggle();
          }
        }
        disabled={!desktopAvailable || autostart === null || autostartBusy}
      >
        <Switch.Thumb class="switch-thumb" />
      </Switch.Root>
    </div>
    {#if desktopAvailable && autostart === null}<p class="muted">
        {autostartBusy ? "正在读取启动设置…" : "启动设置暂时不可用，请重新连接后重试。"}
      </p>{/if}
  </section>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void save();
    }}
    aria-busy={saving}
  >
    <section class="settings-section" aria-labelledby="update-title">
      <h2 id="update-title">插件更新</h2>
      <fieldset disabled={!available}>
        <label class="field"
          >检查间隔（分钟）<input
            type="number"
            min="1"
            max="1440"
            step="1"
            required
            value={draft.checkIntervalMinutes}
            oninput={(event) => update({ checkIntervalMinutes: Number(event.currentTarget.value) })}
          /></label
        >
        <label class="checkbox"
          ><input
            type="checkbox"
            checked={draft.autoUpdate}
            onchange={(event) => update({ autoUpdate: event.currentTarget.checked })}
          />自动安装新增插件和更新</label
        >
        <label class="field"
          >插件来源地址<input
            type="url"
            value={draft.catalogUrl}
            oninput={(event) => update({ catalogUrl: event.currentTarget.value })}
            placeholder="https://…/catalog.json"
            spellcheck="false"
          /></label
        >
        <label class="field"
          >发布者公钥<textarea
            rows="4"
            value={draft.catalogPublicKey}
            oninput={(event) => update({ catalogPublicKey: event.currentTarget.value })}
            spellcheck="false"></textarea></label
        >
      </fieldset>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <div class="actions">
        <button class="primary" type="submit" disabled={!available}
          >{saving ? "保存中…" : "保存设置"}</button
        >{#if edits}<button
            type="button"
            disabled={saving}
            onclick={() => {
              edits = null;
              error = "";
            }}>撤销更改</button
          ><span class="muted">有未保存的更改</span>{/if}
      </div>
    </section>
  </form>
  {#if dataDir}<section class="settings-section" aria-labelledby="directory-title">
      <div class="setting-row">
        <div>
          <h2 id="directory-title">数据存储</h2>
          <p class="muted path">{dataDir}</p>
        </div>
        <button disabled={!desktopAvailable || directoryBusy} onclick={onopen}
          >{directoryBusy ? "正在打开…" : "打开文件夹"}</button
        >
      </div>
    </section>{/if}
</div>

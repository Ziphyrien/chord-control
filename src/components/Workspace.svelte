<script lang="ts">
  import { onMount, untrack } from "svelte";
  import appIcon from "../../resources/icon.svg?url";
  import { defaultSettings } from "../../shared/protocol.ts";
  import type { ControllerSession } from "../lib/session.ts";
  import { SessionView } from "../lib/session.svelte.ts";
  import { formatTime } from "../lib/presentation.ts";
  import PluginList from "./PluginList.svelte";
  import PluginPanel from "./PluginPanel.svelte";
  import ActivityList from "./ActivityList.svelte";
  import SettingsForm from "./SettingsForm.svelte";
  import AddPluginDialog from "./AddPluginDialog.svelte";
  import GroupDialog from "./GroupDialog.svelte";

  let { session }: { session: ControllerSession } = $props();
  const view = new SessionView(untrack(() => session));
  const model = $derived(view.state);
  const online = $derived(model.connection === "online");
  const canMutate = $derived(online && !model.pending.mutation && !model.pending.refresh);
  const pages = ["插件", "活动", "设置"] as const;
  let page = $state<(typeof pages)[number]>("插件");
  let adding = $state(false);
  let addEpoch = 0;
  const errors = $derived(
    Object.entries(model.errors).filter(
      ([key]) =>
        (key !== "mutation" || (!adding && !model.confirmation)) &&
        (key !== "refresh" || !model.confirmation),
    ),
  );
  onMount(() => view.start());
  function closeAdd() {
    ++addEpoch;
    adding = false;
  }
  async function add(manifestUrl: string, publicKey: string) {
    const epoch = addEpoch;
    if (
      (await session.run({ type: "add_plugin", manifestUrl, publicKey }, "插件已添加")) &&
      epoch === addEpoch
    )
      closeAdd();
  }
</script>

<a class="skip-link" href="#content">跳到内容</a>
<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <img src={appIcon} alt="" width="32" height="32" /><span>Chord Control</span>
    </div>
    <nav aria-label="主导航">
      {#each pages as item (item)}
        <button
          class={["nav-item", { selected: page === item }]}
          aria-current={page === item ? "page" : undefined}
          onclick={() => {
            page = item;
            session.closePanel();
          }}>{item}</button
        >
      {/each}
    </nav>
    {#if model.connection === "offline"}
      <div class="connection" role="status">断开连接</div>
    {/if}
  </aside>
  <main id="content" tabindex="-1">
    {#if model.connection !== "online"}
      <div class="connection-banner" role="status">
        <div>
          <strong>{model.connection === "loading" ? "正在连接控制器…" : "连接已断开"}</strong>
          <p>
            {model.snapshot
              ? "当前显示上次收到的内容。连接恢复后可继续操作。"
              : model.connection === "loading"
                ? "连接后将载入你的插件。"
                : "请重试连接。"}
          </p>
        </div>
        {#if model.connection === "offline"}<button onclick={() => session.reconnect()}
            >重新连接</button
          >{/if}
      </div>
    {/if}
    {#each errors as [key, error] (key)}
      <div class="notice error" role="alert">
        <span>{error}</span><button
          class="text-button"
          aria-label="关闭错误提示"
          onclick={() => session.clearError(key)}>关闭</button
        >
      </div>
    {/each}
    {#if model.panel || model.opening}
      <PluginPanel
        panel={model.panel}
        opening={model.opening}
        onclose={() => session.closePanel()}
      />
    {:else}
      <header class="page-heading">
        <div>
          <h1>{page}</h1>
        </div>
        {#if page === "插件"}<div class="actions">
            <button disabled={!canMutate} onclick={() => session.run({ type: "check_updates" })}
              >{model.pending.mutation === "check_updates" ? "检查中…" : "检查更新"}</button
            >
            <button
              class="primary"
              disabled={!canMutate}
              onclick={() => {
                session.clearError("mutation");
                ++addEpoch;
                adding = true;
              }}>添加插件</button
            >
          </div>{/if}
      </header>
      {#if page === "插件"}
        {#if model.snapshot}
          <PluginList
            plugins={model.snapshot.plugins}
            available={canMutate}
            pending={model.pending.mutation}
            onopen={(plugin) => session.open(plugin)}
            oncommand={(command) => session.run(command)}
            onrequest={(plugin, kind) => session.requestChange(plugin, kind)}
          />
          {#if model.snapshot.checkedAt}<p class="muted footnote">
              上次检查 <time datetime={model.snapshot.checkedAt}
                >{formatTime(model.snapshot.checkedAt)}</time
              >
            </p>{/if}
        {:else}<div class="empty">
            <h2>{model.connection === "loading" ? "正在载入插件" : "暂时无法显示插件"}</h2>
            <p>连接成功后，你的插件会显示在这里。</p>
          </div>{/if}
      {:else if page === "活动"}
        <ActivityList items={model.snapshot?.activities ?? []} loaded={model.snapshot !== null} />
      {:else}
        <SettingsForm
          settings={model.snapshot?.settings ?? defaultSettings()}
          available={canMutate}
          saving={model.pending.mutation === "set_settings"}
          desktopAvailable={session.desktop.available}
          autostart={model.autostart}
          autostartBusy={!!model.pending.autostart}
          directoryBusy={!!model.pending.directory}
          dataDir={model.snapshot?.dataDir ?? ""}
          onsave={(settings) => session.run({ type: "set_settings", settings }, "设置已保存")}
          ontoggle={() => session.toggleAutostart()}
          onopen={() => session.openDirectory()}
        />
      {/if}
    {/if}
  </main>
</div>
{#if adding}
  <AddPluginDialog
    busy={model.pending.mutation === "add_plugin"}
    available={canMutate}
    error={model.errors.mutation ?? ""}
    onclose={closeAdd}
    onsubmit={add}
  />
{/if}
{#if model.confirmation}
  <GroupDialog
    confirmation={model.confirmation}
    busy={!!model.pending.mutation || !!model.pending.refresh}
    available={online}
    error={model.errors.refresh ?? model.errors.mutation ?? ""}
    onclose={() => session.closeConfirmation()}
    onconfirm={() => session.confirmChange()}
  />
{/if}
{#if model.notice}<div class="toast" role="status">{model.notice}</div>{/if}

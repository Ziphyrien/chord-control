<script lang="ts">
  import { onMount, untrack } from "svelte";
  import appIcon from "../resources/icon.svg?url";
  import type { ControllerClient } from "./lib/controller.ts";
  import { ControllerSession } from "./lib/session.svelte.ts";
  import { defaultSettings } from "../shared/protocol.ts";
  import PluginList from "./components/PluginList.svelte";
  import ActivityList from "./components/ActivityList.svelte";
  import SettingsForm from "./components/SettingsForm.svelte";
  import AddPluginDialog from "./components/AddPluginDialog.svelte";
  import PluginPanel from "./components/PluginPanel.svelte";

  let { client }: { client: ControllerClient } = $props();
  const session = new ControllerSession(untrack(() => client));
  const pages = ["插件", "记录", "设置"] as const;
  let view = $state<(typeof pages)[number]>("插件");
  let adding = $state(false);
  const visibleError = $derived(
    view === "插件" && session.snapshot?.plugins.some((plugin) => plugin.error === session.error)
      ? ""
      : session.error,
  );
  onMount(() => session.start());
</script>

<svelte:head><title>Chord Control</title></svelte:head>
<div class="shell">
  <aside>
    <div class="brand"><img src={appIcon} alt="" width="28" height="28" /> Chord Control</div>
    <nav aria-label="主导航">
      {#each pages as page (page)}
        <button
          class={["nav-item", { active: view === page }]}
          aria-current={view === page ? "page" : undefined}
          onclick={() => {
            view = page;
            session.panel = null;
          }}>{page}</button
        >
      {/each}
    </nav>
  </aside>
  <main>
    {#if session.panel}
      <PluginPanel
        panel={session.panel}
        onclose={() => {
          session.panel = null;
        }}
      />
    {:else}
      <header class="page-heading">
        <h1>{view}</h1>
        {#if view === "插件"}
          <div class="actions">
            <button
              disabled={!session.canAct}
              onclick={() => session.run({ type: "check_updates" })}
              >{session.pending === "check_updates" ? "检查中…" : "检查更新"}</button
            >
            <button
              class="primary"
              disabled={!session.canAct}
              onclick={() => {
                session.error = "";
                adding = true;
              }}>添加插件</button
            >
          </div>
        {/if}
      </header>
      {#if visibleError && !adding}<p class="error notice" role="alert">{visibleError}</p>{/if}
      {#if view === "插件"}
        {#if session.snapshot}
          <PluginList
            plugins={session.snapshot.plugins}
            available={session.canAct}
            onopen={(plugin) => session.open(plugin)}
            oncommand={(command) => session.run(command)}
          />
          {#if session.snapshot.checkedAt}<p class="muted check-time">
              上次检查 <time>{new Date(session.snapshot.checkedAt).toLocaleString("zh-CN")}</time>
            </p>{/if}
          {#if !session.connected}<p class="error" role="status">连接已断开</p>{/if}
        {:else}<div class="empty">无法连接控制器</div>{/if}
      {:else if view === "记录"}
        <ActivityList items={session.snapshot?.activities ?? []} />
      {:else}
        {#key JSON.stringify(session.snapshot?.settings)}
          <SettingsForm
            settings={session.snapshot?.settings ?? defaultSettings()}
            available={session.canAct}
            autostart={session.autostart}
            dataDir={session.snapshot?.dataDir ?? ""}
            onsave={(settings) => session.run({ type: "set_settings", settings }, "设置已保存")}
            ontoggle={() => session.toggleAutostart()}
            onopen={() => session.openDirectory()}
          />
        {/key}
      {/if}
    {/if}
  </main>
</div>
{#if adding}
  <AddPluginDialog
    busy={session.pending !== null}
    available={session.canAct}
    error={session.error}
    onclose={() => {
      adding = false;
      session.error = "";
    }}
    onsubmit={async (manifestUrl, publicKey) => {
      if (await session.run({ type: "add_plugin", manifestUrl, publicKey })) adding = false;
    }}
  />
{/if}
{#if session.notice}<div class="toast" role="status">{session.notice}</div>{/if}

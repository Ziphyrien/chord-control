<script lang="ts">
  import { onMount, untrack, type Snippet } from "svelte";
  import { setWorkspace } from "../lib/workspace-context.ts";
  import Notice from "@chord-control/ui/Notice.svelte";
  import appIcon from "../../resources/icon.svg?url";
  import { HOST_VERSION } from "../../shared/versions.ts";
  import type { ControllerSession } from "../lib/session.ts";
  import { SessionView } from "../lib/session.svelte.ts";
  import PluginPanel from "./PluginPanel.svelte";
  import AddPluginDialog from "./AddPluginDialog.svelte";
  import GroupDialog from "./GroupDialog.svelte";

  let {
    session,
    currentPath,
    onnavigate,
    children,
  }: {
    session: ControllerSession;
    currentPath: string;
    onnavigate: (path: "/" | "/activities" | "/settings") => void;
    children: Snippet;
  } = $props();
  const view = new SessionView(untrack(() => session));
  const model = $derived(view.state);
  const online = $derived(model.connection === "online");
  const canMutate = $derived(online && !model.pending.mutation && !model.pending.refresh);
  const pages = [
    { path: "/", label: "插件" },
    { path: "/activities", label: "活动" },
    { path: "/settings", label: "设置" },
  ] as const;
  let adding = $state(false);
  let addEpoch = 0;
  const errors = $derived(
    Object.entries(model.errors).filter(
      ([key]) =>
        (key !== "mutation" || (!adding && !model.confirmation)) &&
        (key !== "refresh" || !model.confirmation),
    ),
  );
  setWorkspace({
    session: view.session,
    view,
    openAdd() {
      session.clearError("mutation");
      ++addEpoch;
      adding = true;
    },
  });
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
      {#each pages as item (item.path)}
        <button
          class={["nav-item", { selected: currentPath === item.path }]}
          aria-current={currentPath === item.path ? "page" : undefined}
          onclick={() => {
            session.closePanel();
            onnavigate(item.path);
          }}>{item.label}</button
        >
      {/each}
    </nav>
    <footer class="sidebar-footer">
      {#if model.connection === "offline"}
        <div class="connection" role="status">断开连接</div>
      {/if}
      <span class="app-version" aria-label="主程序版本">v{HOST_VERSION}</span>
    </footer>
  </aside>
  <main id="content" tabindex="-1">
    {#if model.connection !== "online"}
      <div class="connection-banner" role="status">
        <div>
          <strong>{model.connection === "loading" ? "正在连接…" : "连接已断开"}</strong>
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
      {@render children()}
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
{#if model.notice}<div class="toast"><Notice tone="success">{model.notice}</Notice></div>{/if}

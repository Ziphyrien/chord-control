<script>
  import { resolve } from "$app/paths";
  import { onDestroy } from "svelte";
  import { afterNavigate, beforeNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { createClient } from "$lib/client.js";
  import { setTelemetry } from "$lib/context.js";
  import "@chord-control/ui/theme.css";
  import "../app.css";

  let { children } = $props();
  let state = $state.raw();
  let token = $state("");
  const client = createClient({
    onState: (next) => {
      state = next;
    },
  });
  setTelemetry({
    get state() {
      return state;
    },
    session: client.session,
  });
  afterNavigate(() => {
    void client.route({ id: page.params.id ?? null, query: page.url.searchParams.get("q") ?? "" });
  });
  beforeNavigate(({ from, to }) => {
    if (!to || from?.url.pathname !== to.url.pathname || from?.url.search !== to.url.search)
      client.cancel();
  });
  onDestroy(() => client.dispose());
  function login(event) {
    event.preventDefault();
    const credential = token;
    token = "";
    void client.login(credential);
  }
  function pagehide(event) {
    token = "";
    if (event.persisted) client.logout();
    else client.dispose();
  }
</script>

<svelte:window onpagehide={pagehide} />
<svelte:head><title>Chord · 运行状态</title></svelte:head>
<header>
  <div class="brand">CHORD / OBSERVE</div>
  <h1>客户端运行状态</h1>
  <p>查看设备状态与运行记录。</p>
</header>
<main>
  {#if state.authenticated}
    <section id="workspace">
      <div class="toolbar">
        <a href={resolve("/devices")}>设备列表</a><button
          id="logout"
          onclick={() => client.logout()}>退出</button
        >
      </div>
      {@render children()}
    </section>
  {:else}
    <form id="login" onsubmit={login}>
      <label for="token">管理密钥</label>
      <div class="toolbar">
        <input
          id="token"
          type="password"
          autocomplete="current-password"
          required
          bind:value={token}
        />
        <button>进入</button>
      </div>
    </form>
  {/if}
  <p id="error" role="alert">{state.error}</p>
</main>
<footer>默认每5分钟上报 · 已确认设备保留7天历史</footer>

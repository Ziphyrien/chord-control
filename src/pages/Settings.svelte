<script lang="ts">
  import SettingsForm from "../components/SettingsForm.svelte";
  import { getWorkspace } from "../lib/workspace-context.ts";
  import { defaultSettings } from "../../shared/protocol.ts";
  const { session, view } = getWorkspace();
  const model = $derived(view.state);
  const available = $derived(
    model.connection === "online" && !model.pending.mutation && !model.pending.refresh,
  );
</script>

<header class="page-heading"><h1>设置</h1></header>
<SettingsForm
  settings={model.snapshot?.settings ?? defaultSettings()}
  {available}
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

<script lang="ts">
  import ActivityList from "../components/ActivityList.svelte";
  import { getWorkspace } from "../lib/workspace-context.ts";
  const { view } = getWorkspace();
</script>

<header class="page-heading"><h1>活动</h1></header>
<ActivityList items={view.state.snapshot?.activities ?? []} loaded={view.state.snapshot !== null} />

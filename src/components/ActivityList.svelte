<script lang="ts">
  import Select from "@chord-control/ui/Select.svelte";
  import type { ActivityItem } from "../../shared/protocol.ts";
  import { formatTime } from "../lib/presentation.ts";
  let { items, loaded }: { items: ActivityItem[]; loaded: boolean } = $props();
  const filters = [
    { value: "all", label: "全部活动" },
    { value: "attention", label: "需要留意" },
  ];
  let filter = $state("all");
  const visible = $derived(
    items.filter((item) => filter === "all" || item.tone === "error" || item.tone === "warning"),
  );
  const tones = { success: "已完成", info: "信息", warning: "需留意", error: "未完成" };
</script>

<section aria-label="活动记录">
  <div class="list-toolbar">
    <p class="muted">最近变化</p>
    <Select label="筛选活动" items={filters} bind:value={filter} />
  </div>
  <ol class="activity-list">
    {#each visible as item (item.id)}
      <li class="activity-row">
        <span class={["status", item.tone]}>{tones[item.tone]}</span>
        <div>
          <h2>{item.title}</h2>
          <p>{item.detail}</p>
        </div>
        <time datetime={item.time}>{formatTime(item.time)}</time>
      </li>
    {/each}
  </ol>
  {#if !visible.length}<div class="empty">
      <h2>
        {!loaded ? "活动记录尚未载入" : filter === "all" ? "暂无活动记录" : "没有需要留意的记录"}
      </h2>
      <p>{!loaded ? "连接后可查看。" : ""}</p>
    </div>{/if}
</section>

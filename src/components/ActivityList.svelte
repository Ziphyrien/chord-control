<script lang="ts">
  import { Select } from "bits-ui";
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
    <p class="muted">查看插件与设置的最近变化</p>
    <Select.Root type="single" bind:value={filter} items={filters} allowDeselect={false}>
      <Select.Trigger class="activity-filter" aria-label="筛选活动">
        {filter === "all" ? "全部活动" : "需要留意"}
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content class="activity-filter-menu" align="end" sideOffset={6}>
          <Select.Viewport>
            {#each filters as option (option.value)}
              <Select.Item class="activity-filter-option" value={option.value} label={option.label}>
                {#snippet children({ selected })}
                  <span>{option.label}</span>
                  <span class="activity-filter-check" aria-hidden="true">{selected ? "✓" : ""}</span
                  >
                {/snippet}
              </Select.Item>
            {/each}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
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
      <p>{!loaded ? "连接成功后可查看最近活动。" : "新的活动会显示在这里。"}</p>
    </div>{/if}
</section>

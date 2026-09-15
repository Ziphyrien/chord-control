<script lang="ts">
  import type { ActivityItem } from "../../shared/protocol.ts";
  let { items }: { items: ActivityItem[] } = $props();
</script>

<div class="activity-list">
  {#each items as item (item.id)}
    <article class="activity-row">
      <span class={["marker", item.tone]} aria-hidden="true"></span>
      <div>
        <h2>{item.title}</h2>
        <p class="muted">{item.detail}</p>
      </div>
      <time datetime={item.time}>{new Date(item.time).toLocaleString("zh-CN")}</time>
    </article>
  {:else}<div class="empty">暂无记录</div>{/each}
</div>

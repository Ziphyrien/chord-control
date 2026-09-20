<script>
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import Disclosure from "@chord-control/ui/Disclosure.svelte";
  import { getTelemetry } from "$lib/context.js";
  import { deviceName } from "$lib/format.js";
  import { reportView } from "$lib/report.js";
  import DataTable from "$lib/DataTable.svelte";
  import Diagnostics from "$lib/Diagnostics.svelte";

  const telemetry = getTelemetry();
  let result = $derived(
    telemetry.state.selected === page.params.id ? telemetry.state.detail : null,
  );
  let view = $derived(result ? reportView(result) : null);
</script>

<svelte:head><title>{result ? deviceName(result.device) : "设备详情"} · Chord</title></svelte:head>
<section id="detail" aria-busy={telemetry.state.busy}>
  <div class="toolbar">
    <h2 id="name">{result ? deviceName(result.device) : "设备详情"}</h2>
    <button
      id="request"
      disabled={telemetry.state.busy || !result}
      onclick={() => {
        void telemetry.session.requestReport();
      }}>立即采集</button
    >
    <a id="close" href={resolve(`/devices${page.url.search}`)}>返回列表</a>
  </div>
  <p id="request-status" role="status">{telemetry.state.requestStatus}</p>
  {#if result && view}
    <div id="summary" class="cards">
      {#each view.summary as [name, value] (name)}<div class="card">
          {name}<strong>{value ?? "未知"}</strong>
        </div>{/each}
    </div>
    <Diagnostics host={result.device.report.host} />
    <h3>插件状态</h3>
    <DataTable
      id="plugins"
      headers={["插件", "版本 / 可用版本", "状态", "原因"]}
      rows={view.plugins}
    />
    <h3>调用指标</h3>
    <p class="muted">成功率按已结束的调用计算，业务效果见插件核验指标。空值表示暂无数据。</p>
    <DataTable
      id="metrics"
      headers={["插件 / 操作", "次数 / 失败", "成功率", "平均 / 最大耗时", "统计起点", "最近错误"]}
      rows={view.metrics}
    />
    <h3>插件自报指标</h3>
    <DataTable
      id="custom-metrics"
      headers={["插件 / 指标", "值", "单位", "统计起点"]}
      rows={view.custom}
    />
    <h3>最近活动</h3>
    <div id="activities">
      {#each view.activities as activity, index (index)}<p>{activity}</p>{/each}
    </div>
    <h3>历史样本</h3>
    <div id="history" class="scroll">
      {#each view.history as sample, index (index)}<p>{sample}</p>{:else}<p>
          确认客户端后开始保留历史样本。
        </p>{/each}
    </div>
    {#key result.device.id}
      <Disclosure title="完整报告"
        ><pre id="raw">{JSON.stringify(result.device.report, null, 2)}</pre></Disclosure
      >
    {/key}
  {:else if telemetry.state.busy}
    <p role="status">正在读取…</p>
  {/if}
</section>

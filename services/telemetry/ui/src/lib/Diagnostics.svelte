<script>
  import { diagnosticView } from "./diagnostics.js";
  import DataTable from "./DataTable.svelte";
  let { host } = $props();
  let view = $derived(diagnosticView(host));
</script>

<section class="diagnostics" aria-labelledby="diagnostic-heading">
  <h3 id="diagnostic-heading">Windows 远程诊断</h3>
  <p class="muted">结果反映各项采集时间的状态。未知表示数据尚未取得。</p>
  <DataTable id="diagnostic-summary" headers={["项目", "结果"]} rows={view.summary} />
  <h4>UAC 设置</h4>
  <p class="muted">配置值及读取结果。</p>
  <DataTable id="uac" headers={["注册表键", "读取结果"]} rows={view.uac} />
  <h4>目标进程令牌</h4>
  <p class="muted">PID 与创建时间共同识别进程。</p>
  <DataTable
    id="process-tokens"
    headers={[
      "角色",
      "目标 PID",
      "读取结果",
      "观测 PID",
      "创建时间 FILETIME",
      "已提升",
      "提升类型",
      "完整性级别",
      "用户 SID",
      "可执行文件",
      "文件版本",
    ]}
    rows={view.processes}
    empty={view.processEmpty}
  />
  <h4>原生调用失败记录</h4>
  <p id="failure-status" class="muted">{view.failureStatus}</p>
  <DataTable
    id="native-failures"
    headers={[
      "事件 ID / 序号",
      "发生时间",
      "插件 / 操作",
      "调用进程",
      "API",
      "错误代码",
      "目标",
      "请求权限",
      "原始错误",
    ]}
    rows={view.failures}
    empty={view.failureEmpty}
  />
  <h4>只读 DACL 复查</h4>
  <p class="muted">
    显示采样时所列进程对目标路径的权限。使用祖先路径时，仅检查该路径的创建权限；原始失败原因需结合相关记录判断。
  </p>
  <DataTable
    id="registry-checks"
    headers={[
      "事件 ID",
      "插件 / 操作",
      "复查结果",
      "采集时间",
      "检查路径",
      "使用祖先路径",
      "原请求权限",
      "实际检查权限",
      "授予权限",
      "令牌进程",
    ]}
    rows={view.registry}
    empty={view.registryEmpty}
  />
  <h4>权限内容</h4>
  <DataTable
    id="registry-security"
    headers={[
      "事件 ID",
      "检查路径",
      "读取结果",
      "所有者",
      "所属组",
      "阻止继承",
      "自动继承",
      "权限描述符",
    ]}
    rows={view.security}
    empty={view.securityEmpty}
  />
  <p class="muted">{view.aceLimit}</p>
  <DataTable
    id="registry-aces"
    headers={["事件 ID", "用户或组", "规则", "权限", "继承所得", "仅用于继承"]}
    rows={view.aces}
    empty="当前报告没有可显示的权限条目。"
  />
  <h4>来源证据</h4>
  <p id="vendor-evidence" class="muted">{view.vendor}</p>
  <DataTable
    id="registry-attribution"
    headers={["事件 ID", "当前权限", "访问失败审计", "关联权限修改记录"]}
    rows={view.attribution}
    empty={view.evidenceEmpty}
  />
  <DataTable
    id="evidence-summary"
    headers={["项目", "结果"]}
    rows={view.sourceSummary}
    empty={view.evidenceEmpty}
  />
  <DataTable
    id="evidence-channels"
    headers={["日志通道", "读取状态", "检查记录数", "原因"]}
    rows={view.evidenceChannels}
    empty={view.evidenceEmpty}
  />
  <DataTable
    id="evidence-events"
    headers={[
      "关联事件",
      "记录时间",
      "通道",
      "提供方 / 事件 / 记录号",
      "操作",
      "目标",
      "记录中的进程",
      "操作账户",
      "关联依据",
      "时间差（毫秒）",
    ]}
    rows={view.evidenceEvents}
    empty={view.evidenceEmpty}
  />
</section>

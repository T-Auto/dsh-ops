# 宿主接入与验证边界

`ops-ptc` 2.0.3 保留独立 Tool adapter，接口与 2.0.1 一致。它已对真实安装的 `dsh-ops` 0.4.1 Outcome schema 和 DSH ToolRuntime 注册接口验证；生产宿主的可信执行桥尚未接入。不能把这些测试解释为原生 discovery 直插、完整文件权限隔离或真实宿主端到端验证。

## 注册五个工具

入口为 `ops-ptc/tools`，导出 `createHostTools`、`registerHostTools`、`toHostOutcome`、`HOST_OUTCOME_SCHEMA` 及结构化类型。

下面是宿主调用的完整注册函数。参数 `bridge` 必须由宿主实现并注入，返回的清理函数应接入插件卸载生命周期。

```ts
import {
  registerHostTools,
  opsPtcAddition,
  type HostBridge,
  type HostToolDefinition,
} from 'ops-ptc/tools';

export function installPtc(
  ctx: { tools: { register(definition: HostToolDefinition): () => void } },
  bridge: HostBridge,
): () => void {
  return registerHostTools(ctx, opsPtcAddition, bridge);
}
```

请传插件当前作用域的 `ctx.tools`。adapter 逐个注册五个 ToolDefinition，包含 `parameters`、`execute`、`output.schema`、`output.render` 和 120000 ms 的协作超时声明。注册中途失败会释放先前注册；返回的正常清理函数支持重复调用。

`opsPtcAddition` 和 `opsPtcDiscoveryEntry` 是自定义元数据。安装原包 `dsh-ops` 不会自动把它们加入其固定 discovery registry。`opsPtcDiscoveryEntry.load()` 也不会执行注册。宿主若需要动态发现，应显式维护这些新工具的发现、加载和生命周期。

## 实现可信执行桥

`HostBridge` 的接口来自本包，不是假定原包存在同名公开权限 API：

```ts
interface HostBridge {
  sandboxPolicy: {
    resolve(input: {
      session: { id?: string | number };
    }): {
      mode: 'read-only' | 'workspace-write' | 'danger-full-access';
      workspaceRoot: string;
    };
  };
  invoke?: (
    name: string,
    args: Record<string, unknown>,
    exec: {
      agent?: { session?: { id?: string | number } };
      signal?: AbortSignal;
    },
    policy: {
      mode: 'read-only' | 'workspace-write' | 'danger-full-access';
      workspaceRoot: string;
    },
  ) => Promise<unknown>;
}
```

接线顺序：

1. 从宿主真实执行上下文取得 `exec.agent.session`；policy resolver 使用该 session 查询当前授权和工作区。拒绝把模型参数、环境默认值或固定的 `danger-full-access` 当作授权来源。
2. `invoke` 对全部输入、输出、临时文件和子进程路径执行宿主路径策略；覆盖绝对路径、相对路径、符号链接/junction、凭证路径和读写模式。`workspaceRoot` 字段本身没有 confinement 能力。
3. 在实际读取、启动进程、创建临时文件以及提交修改前，按宿主机制重验授权；已有 `proc.ts` 和裸 engine handlers 不提供这层权限桥。不要把 `invoke` 直接绑定为 `opsPtcAddition.handlers[name](args)`。
4. 把 `exec.signal` 传递到所有在途工作。取消后等待已启动工作停止并收集落盘状态，不能让未受控的后台改写继续执行。adapter 只检查派发前取消，120 秒声明也不代表能够硬停进程内引擎。
5. 返回完整结果凭据，包括已提交文件、失败项、回滚状态及未知副作用。adapter 规范化 Outcome；宿主仍需负责执行结果的真实性。

缺 session、policy、合法绝对工作区或 `invoke` 时，adapter 返回 `EXECUTOR_UNAVAILABLE`，不调用裸 handler。`read-only` 下拒绝 apply 模式和可能创建临时文件的 audit。其余读操作的路径和凭证访问由可信桥执行约束。

## Outcome 与原包的区别

引擎的扁平 `status: ok/error` 不能直接充当原包 canonical Outcome。adapter 把成功映射为 `completed.data`，失败映射为嵌套 `error` 并保留原始 `data`，方便核实部分提交。

截断、剪枝或不完整结果没有可用 coverage 和 continuation 时返回 `RESULT_PARTIAL`，不会伪造下一页或宣称完整。写派发后无法确认结果时 `effectState` 为 `unknown`。

原包 `contract.definition()` 包裹的是原包 worker receipt 正规化过程。不要再用它包裹 adapter Outcome；它会再次解释结果并重新生成 continuation。adapter 生成的定义直接交给 `ctx.tools.register()`。

## 复现兼容测试

在本仓库先执行 `npm run build`，然后指定真实安装目录：

```bash
node scripts/host-compat-smoke.mjs \
  --ops-root C:/Users/Administrator/.dsh/profiles/desktop/node_modules/dsh-ops \
  --host-root K:/ai/.tmp/dsh-ops/node_modules
```

`--ops-root` 指向包含 `lib/ptc/contract.js` 的原包目录；`--host-root` 指向同时包含 `@deepseek-ai/dsh-tools` 和 `@deepseek-ai/cordis` 的 node_modules。依赖缺失会失败，不会静默跳过。

本次结果为 88 条断言通过，另有真实宿主声明文件的 strict TypeScript consumer 编译通过：ToolDefinition 结构赋值、ToolRuntime 注册类型、原包 schema 和 contract、真实注册/执行/清理/失败回滚、缺桥拒绝、read-only、取消、截断和副作用未知状态。仅附属 systemPrompt 服务使用测试 stub；真实生产 invoke、原生 discovery 自动加载、宿主隔离和完整工具调用权限链尚未验收。

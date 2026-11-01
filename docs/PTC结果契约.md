# PTC 结果契约

读取后编辑的完整示例、revision 字段对照及部分替换回执见[文件读写契约](文件读写契约.md)。

English: [PTC result contracts](ptc-outcomes.md).

0.4.0 的 PTC 组件独立提供文件、批处理和结果引用 SDK，不依赖 Native 文件组件。
每个绑定都返回 `Outcome<T>` 值。Native 继续输出紧凑文本；PTC 的 `data` 保留规范结构化数据。
可见性与下一轮激活规则见 [SDK 按需加载](PTC按需加载.md)。

| 状态 | 必需字段 | 调用方操作 |
| --- | --- | --- |
| `completed` | `data` | 处理本次请求对应的结果。 |
| `partial` | `data`、不完整的 `coverage`、`continuation` | 检查已保留数据，显式读取剩余范围或引用页。 |
| `rejected`、`conflict`、`error`、`unknown` | `error`，可选保留 `data` | 根据 `code`、`effectState`、`retry` 和 `nextAction` 处理。 |

成功的 plan 只表示规划完成，不表示修改已执行。`result.put` 不回显行仍可表示存储完成。
批处理中失败的条目保留在数据中，并返回错误；中断的修改绝不会获得自动重试游标。
`unknown` 必须通过只读检查确认副作用。不能在 `partial` 上访问 `error`，也不能把所有非错误
状态当成完整结果。

```ts
// 当前 agent 已激活 ops_read_files 后：
const result = await tools.ops_read_files({
  files: [{ path: "src/a.ts", offset: 1, limit: 20 }]
});
if (result.status === "completed") {
  return { lines: result.data.items?.map(file => file.items?.length ?? 0) };
}
if (result.status === "partial") {
  return { coverage: result.coverage, continuation: result.continuation };
}
return { code: result.error.code, effectState: result.error.effectState,
  retry: result.error.retry, action: result.error.nextAction };
```

续取值描述有界只读操作，保留原查询、分页上限、所选字段和操作根目录。修改回执溢出后，
续取使用 `result.page`，绝不重复写入。引用页沿原引用推进，不会生成嵌套引用。没有进展、
物理搜索未完成、描述符过大或无法安全续取时，返回 `RESULT_PARTIAL`、保留数据与明确指引，
不伪造游标。每次续取仍核实当前权限与 SDK 可见性；没有自动执行或自动重试工具的辅助器。

搜索扫描覆盖、快照捕获完整性和页面完整性是不同事实。读完已存储页不代表原始扫描完整。
使用快照时检查 `data.source` 和原始搜索报告，详见[结果预算](结果预算.md)。

## 生成类型声明

`npm run build` 从与宿主校验和 SDK 段相同的能力清单及 Outcome schema 生成
`lib/ptc/sdk.d.ts`，并随 npm 包发布。此文件属于构建产物，不可手工修改。TypeScript 调用方
可以使用纯类型导出：

```ts
import type { OpsSdk, Outcome, StorageReference } from "dsh-ops/ptc-sdk";
```

`OpsSdk` 描述完整受支持 API，不代表某个 agent 已加载全部绑定；宿主实际 SDK 段只包含
当前可见且已激活的绑定。必需参数、枚举、嵌套范围/编辑结构与状态收窄保持类型约束；扩展
数据保持 JSON。参数说明中的数值上限由 worker 执行。此导出不会加载宿主服务或创建另一运行时。

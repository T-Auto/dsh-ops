# B 档 · 动态隔离测试报告（dsh-ops → dsh 0.2.1-alpha.5）

- 日期：2026-10-17（凌晨 02:40 – 04:30）
- 测试对象：**dsh-ops 0.2.1rc1 候选（repo/）** 对 **dsh 0.2.1-alpha.5（npm 正式发布包）**
- 测试组：`iso/dsh-home-021a5`（隔离 DSH_HOME）+ profile `iso-021a5` + 隔离 CLI `iso/dsh-cli-021a5`
- 安装方式：`dsh plugin --profile iso-021a5 add dsh-ops`（file: 指向 repo/）+ 手补 `@deepseek-ai/dsh-web-app` bundle
- 模型后端：llama.cpp 127.0.0.1:8080（Qwen3.6-35B-A3B IQ2_M）——**未用于工具调用验证**（见「核不了」节）

## 一、结论速览

| 维度 | 判定 | 证据 |
|---|---|---|
| 安装（plugin add / file: repo） | ✅ 已核 | profile package.json 依赖 + node_modules 实体 |
| 启动（0.2.1-alpha.5 web） | ✅ 已核 | 19394 服务、日志 URL、workspace.json |
| 插件识别（GUI 插件页） | ✅ 已核 | 「已安装插件：dsh-ops」+ 描述 |
| 组合挂载（cordis 组合） | ✅ 已核 | `--dump-config` 输出 4 组件（shell/file 启用） |
| 模块加载（宿主 require 插件） | ✅ 已核 | `require('dsh-ops')` 成功，导出 apply/applyComponent/name |
| 依赖架构（宿主包解析） | ✅ 已核 | 宿主半部零 `@deepseek-ai` npm 值依赖（grep 全树 47 处命中：44 处 test/ 与注释/字符串） |
| runtime 依赖（`@dsh-ops/*`） | ✅ 已核 | profile node_modules 顶层含 @dsh-ops scope |
| 组件 apply 的 ctx API 面（运行时） | ❓ 未核 | 无模型会话未触发组件服务实例化；API 面以 L1 静态对照为准 |
| 工具注册对模型可见 / 工具执行 | 🚫 核不了 | 本地模型工具调用不可靠（35B IQ2 / 4B 量化），用户判定不做 |
| 端到端（模型→ops_bash→结果） | 🚫 核不了 | 同上 |

整体判定：**0.2.1-alpha.5 上 dsh-ops 的安装/启动/挂载/加载链路全部通过动态验证；工具链路（模型调用）依赖能出工具的模型，本地不可行，未判定 ≠ 通过。**

## 二、已核证据（含摘录）

### 1. 安装与组合
- profile `package.json`：`bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-ops"]`，依赖 `"dsh-ops": "file:../../repo"`
- **关键修复**：0.2.1-alpha.5 的 `plugin add dsh-ops` 初始化只给 base+插件两个 bundle（无 web-app）→ boot 后无前端入口挂死；对照 0.2.0-rc.2 正常组（iso-fix，3 bundles）后手补 `@deepseek-ai/dsh-web-app` → 启动成功。**这是 0.2.1-alpha.5 自定义 profile 初始化的形态差异（非 bug），适配方须知**。
- `--dump-config`（对隔离 home，安全）尾段：
  ```
  # == dsh-ops, patched by .../cordis.patch.yml
  - id: dsh-ops-shell  name: dsh-ops/shell  config: { promptPolicy: true, publishBashTool: true, shellPolicy: advise, ... }
  - id: dsh-ops-file   name: dsh-ops/file   config: { promptPolicy: true, required: false, ... }
  - id: dsh-ops-ptc    name: dsh-ops/ptc    disabled: true
  - id: dsh-ops-tui    name: dsh-ops/tui    disabled: true
  ```
  四组件全部进入宿主组合；shell/file 启用（publishBashTool: true = 发布 bash 工具）。

### 2. 启动
- `web-021a5.log`：`dsh web: http://127.0.0.1:19394/?token=...`（此前多轮挂死 = bundles 缺 web-app）
- 端口 19394 返回 401（token 鉴权，服务正常）；`storages/workspace.json` 初始化写入
- 修复点复现：bundle 修改前进程存活但零输出零端口；修改后 80s 内 URL 输出 + 端口就绪

### 3. GUI 插件识别（CDP 无头 Chrome 实测）
插件页输出摘录：`已安装插件 / dsh-ops / 为dsh提供bash、powershell7及一系列rust编写的高性能tools来提高token效率`

### 4. 模块加载（Node 实证，模拟宿主 require）
```
resolve dsh-ops/package.json -> ...\profiles\iso-021a5\node_modules\dsh-ops\package.json
OK 加载成功 导出键数: 3 前16: apply, applyComponent, name
```
- dsh-ops 顶层 = **真实目录**（非 pnpm store 链接）；`.pnpm` 仅 lock.yaml
- 入口顶层无宿主依赖（CJS 可加载），组件按需 apply

### 5. 依赖架构（修正 L1 未决项②）
- `repo/lib` 内 `@deepseek-ai` 命中仅 5 处：index.js 注释、「no @deepseek-ai value imports」自述、session-pwsh.js 组件名**字符串比较**、profile-install.js `require.resolve('.../package.json')` 路径探测、其余注释
- 全树 47 处命中：repo/test/** 占 30+（mock 宿主，测试自洽），scripts 1 处
- **结论：dsh-ops 宿主半部零 npm 宿主值依赖，集成全靠 cordis ctx 接口**（`ctx.get('tools')`、`root.inject(['systemPrompt'])`、`ctx.on('agent/created')` 等）。L1 所列「4 个宿主提供包被引用」口径调整为：**仅注释/字符串/路径探测，非运行时 import**。

## 三、未核（原因明确）

1. **组件 apply 在真实宿主 ctx 的运行态**：web 正常运行未崩溃 ≠ apply 成功（cordis 组件服务惰性实例化；无会话请求不会实例化 dsh-ops 组件）。判定证据需要实例化触发——受限于无可用模型。
2. **ctx API 面符号兼容**（`tools.schemas/tools.restrict/tools.guard/systemPrompt.section` 等 0.2.1-alpha.5 签名）：本档未测运行时，L1 静态对照结论不变（未判定）。
3. **工具对模型可见性**（bash/pwsh/file/read_image 工具名出现在会话工具清单）。

## 四、核不了（受限说明）

1. **模型端到端（模型→ops_bash→结果）**：本机可用的仅 llama.cpp 35B-A3B-IQ2 与 Ollama 4B，函数调用格式遵循不可靠（用户判定「不可能成功调用工具」认可）；无 DeepSeek 官方 API key（生产凭据非本任务可用）。故宿主对工具的系统提示注入与执行回传链路**未做运行时验证**——这是 B 档唯一未覆盖的动态面，也是 0.2.1-alpha.5 发版前建议用能出工具的模型补测的点。
2. 0.2.1 web 内部 API 无公开路由（/api/* 404），运行时工具注册表无法经 HTTP 旁路取证。

## 五、与 L1 未决项对账

| L1 未决项 | B 档处置 | 现状 |
|---|---|---|
| ① cordis 在 profile 的解析版本 | 实测：dsh-ops 插件顶层加载不需要 npm cordis 依赖（ctx 由宿主注入）；profile 内无独立 cordis 解析点 | ✅ 澄清（无此风险面） |
| ② 14 个引用包的主机安装布局 | 实测：lib/ 无 @deepseek-ai 值 import；「引用」= 注释/字符串/路径探测；@dsh-ops runtime 正确装入 profile | ✅ 澄清（架构自含） |
| ③ 深层 API 符号面 | 静态未决；动态需组件实例化（受模型限制未触发） | ❓ 维持未判定 |

## 六、发现与建议

1. **0.2.1-alpha.5 特有问题（已修复/规避）**：自定义 profile 缺 web-app bundle 会静默挂死（无日志、无端口、cordis.yml 被重写一次后无下文）。发布说明建议给用户写清「`plugin add` 后若 web 无响应，检查 bundles 是否含 `@deepseek-ai/dsh-web-app`」。
2. **安装形态**：file: 安装 → dsh-ops 实体目录在 profile node_modules（无 store 链接），模块加载成功；@dsh-ops runtime scope 由 plugin add 正确装入。
3. **发版前补测**：建议在能出工具的模型（DeepSeek 官方/强 function-calling）上跑「会话内调用 ops_bash」全链路一次——B 档所有未核项可一次性关闭。
4. 隔离组保留：`iso/` 全套可复跑（run-web-021a5.sh 一键起）。

## 七、文档

- 本报告：`适配检查\B档-动态隔离测试-报告.md`
- L1 报告：`适配检查\L1-静态比对-报告.md`（未决项②已由本档澄清）
- 探针/脚本：`iso/probe-*.js`、`iso/diag-*.sh`、`iso/run-web-021a5.sh`

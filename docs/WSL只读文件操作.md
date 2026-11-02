# 可选 WSL 只读文件操作

实测 DSH rc.2 宿主无法通过 Windows `Get-Acl` 准备 WSL UNC 工作区。因此 workspace-write 下原有 PTC 运行时会拒绝启动，旧版缓存准备也可能不可用。内联 Native 读取仍可运行；字节裁剪的请求回退后与原 Windows 结果完全一致，包括输出不完整标志。OPS 不修改权限模式，也不绕过宿主拒绝。独立 full-access 夹具验证共享 PTC 文件绑定；这是测试范围说明，不是扩大用户权限的建议。

full-access 下，缺少 `sandbox.prepareResultStorage` 的宿主有意不启用可选存储，避免仅为缓存准备工作区 ACL（#411）。这两种旧宿主情形下，WSL 验收脚本会验证未授予存储权限，并逐字段对比关闭 WSL 开关后的 Windows 结果。宿主提供仅缓存准备能力时，缺少引用仍会导致验收失败，且必须能够分页。Windows 缓存契约套件另以该能力的测试实现验证真实私有 ACL 准备、溢出、分页和清理；这不代表已发布的宿主提供了该能力。

实际 UNC 授权测试运行 `node scripts/verify-wsl-readonly.mjs Ubuntu workspace-write`；独立跨根夹具运行 `node scripts/verify-wsl-readonly.mjs Ubuntu danger-full-access`。两者均要求该分支构建且凭据一致的 Windows/Linux worker。脚本明确断言已知宿主限制，检查撤权竞争窗口，并在取消前记录 Linux worker PID 和启动时间、取消后确认该进程已消失。

环境变量须设置到 DSH daemon/桌面进程，并重启该进程。在无关终端修改环境变量不会改变已运行的 DSH。关闭开关后，已有 WSL 游标会明确失败。

English: [Optional WSL file reads](wsl-readonly.md).

在 Windows x64 上，可在启动 DSH 的环境中设置 `DSH_OPS_WSL_READS=1`，为工作目录位于 `\\wsl.localhost\<发行版>\...` 或 `\\wsl$\<发行版>\...` 的会话启用 Linux 侧 `ops_glob`、`ops_grep` 和 `ops_read_files`。此功能主要减少 WSL 网络文件系统上的重复元数据访问。WSL 启动和校验也有固定开销，小文件读取可能更慢；应先测量实际工作目录再广泛启用。

安装包必须同时包含普通 Windows worker，以及版本一致、凭据文件校验通过的 `runtime/linux-x64/dsh-ops-worker`。发行版须已安装、支持 Linux x64，并提供 `/usr/bin/wslpath` 和 `/usr/bin/sha256sum`。OPS 不安装 WSL，也不下载运行时。显式 `workerPath` 或 `DSH_OPS_WORKER_BIN` 选择仍使用原有 Windows 路径。关闭环境开关后，新请求恢复原有路径。

worker 通过 `wsl.exe --distribution <名称> --exec <已校验的 worker>` 接收 JSON 数据，不运行命令 shell 或模型提供的代码。输入路径须属于会话所在发行版。每次调用都会重新解析 Windows 盘符挂载，包括凭据拒绝根和 worker 路径，并核对 Linux 侧可见文件的 SHA-256。Linux 遍历仍采用 Windows 不区分大小写的凭据拒绝规则和保留文件名限制。符号链接、特殊对象仍执行 no-follow；无效文件名属于扫描缺口，不得宣称计数完整。

工具名称、参数 schema、提示词、相对路径基准及宿主读取记录不变。只转换已定义的结果路径字段为 UNC，不改写文件内容。写入、Bash、PTC 执行和结果缓存所有权仍保留在原有 Windows 路径。

搜索分页使用不透明 `w1:` continuation，绑定发行版、worker 摘要及 Windows 路径规则。内部原生游标仍校验查询、会话、授权和文件系统快照。已有 Windows 游标只走 Windows。WSL 后端不可用时明确失败；发行版、文件版本改变或快照过期时须重新查询。Native 与 PTC 文件绑定共用此文件路由；仅在会话、查询、授权和后端保持一致时，游标才可跨投影使用。PTC 程序和运行时本身仍在 Windows 执行。不得编辑或去掉前缀。

Linux worker 永远不获得结果存储授权。新请求若需要字节裁剪后的完整捕获或存储引用，先丢弃推测性只读结果，再由原 Windows worker 执行原请求：缓存可用时使用受保护缓存，否则保留原有的有界输出契约；仅提交最终结果的宿主读取记录。已绑定 WSL 的游标不能切换缓存后端：页面过大时返回 `OUTPUT_LIMIT`，须缩小范围后重新查询。普通行范围及有界搜索分页仍可内联返回。准备、委派及 Windows 回退共享一次 worker 超时预算；取消或超时后不会再重试。

验证分为两层：普通 CI 覆盖路径、游标、覆盖率及原生限制；宣布可用之前，还须在真实 Windows + WSL 环境验证执行、分页、读取记录和回退。关联 PR 应列出发行版、worker 摘要和真实命令。仅 Windows 单元测试通过不能作为 WSL 验证证据。

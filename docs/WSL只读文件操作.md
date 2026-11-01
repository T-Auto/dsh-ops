# 可选 WSL 只读文件操作

环境变量须设置到 DSH daemon/桌面进程，并重启该进程。在无关终端修改环境变量不会改变已运行的 DSH。关闭开关后，已有 WSL 游标会明确失败。

English: [Optional WSL file reads](wsl-readonly.md).

在 Windows x64 上，可在启动 DSH 的环境中设置 `DSH_OPS_WSL_READS=1`，为工作目录位于 `\\wsl.localhost\<发行版>\...` 或 `\\wsl$\<发行版>\...` 的会话启用 Linux 侧 `ops_glob`、`ops_grep` 和 `ops_read_files`。此功能主要减少 WSL 网络文件系统上的重复元数据访问。WSL 启动和校验也有固定开销，小文件读取可能更慢；应先测量实际工作目录再广泛启用。

安装包必须同时包含普通 Windows worker，以及版本一致、凭据文件校验通过的 `runtime/linux-x64/dsh-ops-worker`。发行版须已安装、支持 Linux x64，并提供 `/usr/bin/wslpath` 和 `/usr/bin/sha256sum`。OPS 不安装 WSL，也不下载运行时。显式 `workerPath` 或 `DSH_OPS_WORKER_BIN` 选择仍使用原有 Windows 路径。关闭环境开关后，新请求恢复原有路径。

worker 通过 `wsl.exe --distribution <名称> --exec <已校验的 worker>` 接收 JSON 数据，不运行命令 shell 或模型提供的代码。输入路径须属于会话所在发行版。每次调用都会重新解析 Windows 盘符挂载，包括凭据拒绝根和 worker 路径，并核对 Linux 侧可见文件的 SHA-256。Linux 遍历仍采用 Windows 不区分大小写的凭据拒绝规则和保留文件名限制。符号链接、特殊对象仍执行 no-follow；无效文件名属于扫描缺口，不得宣称计数完整。

工具名称、参数 schema、提示词、相对路径基准及宿主读取记录不变。只转换已定义的结果路径字段为 UNC，不改写文件内容。写入、Bash、PTC 执行和结果缓存所有权仍保留在原有 Windows 路径。

搜索分页使用不透明 `w1:` continuation，绑定发行版、worker 摘要及 Windows 路径规则。内部原生游标仍校验查询、会话、授权和文件系统快照。已有 Windows 游标只走 Windows。WSL 后端不可用时明确失败；发行版、文件版本改变或快照过期时须重新查询。Native 与 PTC 文件绑定共用此文件路由；仅在会话、查询、授权和后端保持一致时，游标才可跨投影使用。PTC 程序和运行时本身仍在 Windows 执行。不得编辑或去掉前缀。

Linux worker 永远不获得结果存储授权。新请求若需要字节裁剪后的完整捕获或存储引用，先丢弃推测性只读结果，再由原 Windows worker 使用受保护缓存执行原请求；仅提交最终结果的宿主读取记录。已绑定 WSL 的游标不能切换缓存后端：页面过大时返回 `OUTPUT_LIMIT`，须缩小范围后重新查询。普通行范围及有界搜索分页仍可内联返回。准备、委派及 Windows 回退共享一次 worker 超时预算；取消或超时后不会再重试。

验证分为两层：普通 CI 覆盖路径、游标、覆盖率及原生限制；宣布可用之前，还须在真实 Windows + WSL 环境验证执行、分页、读取记录和回退。关联 PR 应列出发行版、worker 摘要和真实命令。仅 Windows 单元测试通过不能作为 WSL 验证证据。

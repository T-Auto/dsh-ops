# 配置下载替代命令

单行 `dsh-ops` 的可选 `download-guard` 配置段会拒绝已识别的 shell 落盘下载，
并返回用户配置的下载器命令。默认关闭；启用但模板为空时也不注册监听器。
不捆绑下载器，不自动改写或后台下载，不探测网络，也不承诺替代方案在每种网络上更快。

```yaml
config:
  download-guard:
    enabled: true
    downloadGuard:
      template: 'my-downloader --output {file} -- {url}'
      shell: bash
```

将 `my-downloader` 换成已安装的可执行文件或脚本。`shell` 可为 `bash`（默认）或
`pwsh`，决定替代命令的参数引用方式；模板必须符合所选 shell 的语法。
`{url}` 必填，`{file}` 可选。占位符必须是独立且未加引号的参数，约束层会对字面值加引号。
不会猜测 URL 或文件名。若模板需要 `{file}`，但原命令从远端推导文件名，则原样放行。

识别范围包括单个字面 URL 的 `curl -o`/`-O`、`wget -O`/裸 `wget`、带空格的
`> file` 重定向，以及带输出参数的 PowerShell `Invoke-WebRequest`、
`Invoke-RestMethod`、`Start-BitsTransfer`。读取 shell 工具的 `command` 参数，
包含 PTC 子调用。拒绝发生在 shell 工具执行前，并携带 `DOWNLOAD_TO_FILE`。
禁用或卸载组件会撤回约束，不改变工具 schema 或提示词字节。

这是工作流偏好，不是完整 shell 解析器或安全边界。不推断下载大小、不读取
`script_path`、不展开变量、不解析 heredoc/命令替换，也不转换任意 shell 程序。
含歧义、多 URL、标准输出/丢弃输出或未识别形式均放行；检测器异常也放行原调用。
不要依赖此功能禁止网络访问。

采用替代命令前，请保留认证、请求头、续传参数、工作目录、校验和及其它请求语义，
并遵守当前沙箱与审批要求。约束不会授权另一工具或权限档，不验证配置的可执行文件，
也不会执行建议。`shell` 只影响建议命令语法，不改变原调用使用的 shell。
替代程序不可用时，由用户调整配置或关闭可选约束。

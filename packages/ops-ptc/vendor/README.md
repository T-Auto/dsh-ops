# vendor

`es.exe`（Everything CLI，1.1.0.38，262 KB）随发布包装箱，**不进仓库**：二进制走
GitHub Releases / npm 产物，源码树里只留这份说明。

需要本地补齐时，把 Everything CLI 的 `es.exe` 放到本目录，`pickExistingEs()` 会按
「包内 `vendor/es.exe` → PATH 上的 `es`」顺序解析。缺它时只有 `ptc_find` /
`ptc_refactor` 的 Everything 枚举段受影响：`ptc_locate` 有 walk 兜底，`ptc_inproc`
给了 `file` 就完全绕过枚举。

# 审计报告 — ops-symbol-map 20261029

范围：`ops_symbol_map` 并入 dsh-ops 后的第三轮审计。这一轮把「检查时没有链接」补成「读取时不可能有链接」，并补上一直缺的 manifest。

## 1. 结论

| 项 | 20261028 | 20261029 |
| --- | --- | --- |
| `lstat` → `open` 窗口 | 敞开 | 一次 `realpath` 收口 |
| 语法包声明 | 无 manifest，靠手工 `npm i` | `optionalDependencies` |
| `limit` 缺省页大小 | 代码 512 / 文档 64 | 三处统一 512 |
| 热态延迟 | 0.06 ms | 0.18–0.20 ms |

## 2. 缺陷：`lstat` 与 `open` 之间的替换窗口

`reparseEscape` 从叶子逐级 `lstat` 到锚点，命中任何 symlink/junction 即拒。这道防线证明的是「检查的那一刻没有链接」，不是「读的那一刻不可能有链接」——中间把叶子换成 junction，`lstat` 仍报普通文件，`open` 已经跟到栏外。原装 Rust 用 `open_nofollow`，这一步在内核里是原子的；Node 的 `readFileSync` 没有等价物。

修法：`lstat` 之后补一次 `realpathSync.native(trusted)`，把「实际要读的」折回真实路径，再跑锚点包含判定与凭据判定。目标不存在时交给引擎报 `NOT_FOUND`，不在这里替它定罪。

窗口从「两次 syscall 之间」收窄到「一次 realpath 之内」，代价是一次 `lstat` + 一次 `realpath`：热态 0.06 → 0.18–0.20 ms。原生侧同样要付这两个 stat，只是付在 Rust 里，所以这不是「进程内更慢」，是「同一件事在这里显式付」。

## 3. 缺陷：没有 manifest，语法包随时会消失

这份源码包此前没有任何 `package.json`。摊进 `dsh-ops/lib/symbol-map/` 后，三个语法包（`tree-sitter` / `-typescript` / `-javascript`）是手工装进宿主目录的。换机、重装、`pnpm install --frozen-lockfile` 都会抹掉它们，`symbol_map` 随即整条变成 `EXECUTOR_UNAVAILABLE`。

修法：声明 `optionalDependencies`。三个语法包都带原生编译，装不上时不该阻断整个安装；缺失时只有 `symbol_map` 不可用，`read_files` 等不受影响，回执的 `nextAction` 给出确切的安装命令。

## 4. 文档漂移：缺省页大小

`DEFAULT_LIMIT = 512`（`src/symbol-map/snapshot.ts:20`），工具 schema 的 `limit` 描述与 README 都写 64。调用方按 64 算分页会多切 8 倍，也就是多 7 轮往返。三处统一成 512。

## 5. token 账

符号表的价值是字节压缩，不是省调用：

| 取法 | token | 相对全文 |
| --- | --- | --- |
| 全文读（10 个 .js） | 97,950 B（撞 128 KiB 预算，没读完） | 100% |
| `symbol_map` ×10 | 6,853 B | 7.0% |

行格式 `"19-24 f failure"` 实测 6.8–7.3 token/符号。10 个文件的符号表约 7 个符号/文件、50 token，同等信息的 `read_files` 需要 3,700 token 一轮。

## 6. 残余风险

1. **目录链 TOCTOU**：`realpath` 复核收口的是叶子，父目录在 `realpath` 与 `open` 之间仍可被换。彻底消掉需要 `openat` 逐级下钻，Node 不暴露。
2. **`extended` 模式**：额外抓 `const` 箭头绑定，符号数会显著增加（512 上限照样生效）。
3. **`revision` 只在单次解析内自洽**：跨进程比对没问题，但它不证明文件在解析后没被改。

## 7. 验证

```
node check.mjs
SM manifest optionalDeps tree-sitter,tree-sitter-javascript,tree-sitter-typescript
SM realpath recheck true | inside import true
```

适配层实跑：`invokeSymbolMap` 三次调用分别 16 / 1 / 1 ms，8 个符号，`revision` 64 hex。

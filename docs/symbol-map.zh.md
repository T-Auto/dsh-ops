# `ops_symbol_map` — 只为结构付费，不为正文付费

`ops_symbol_map` 把“这个文件里有什么”回答成一串符号位置。它是唯一**从不启动原生 worker** 的
文件工具：符号表是对已有字节做一次 Tree-sitter 查询，起子进程的成本比干活本身还高。

```jsonc
{ "path": "src/file/symbol-map.ts", "name": "invokeSymbolMap", "limit": 50 }
```

| 字段 | 含义 |
| --- | --- |
| `path` | 必填，相对会话 cwd。 |
| `name` | 大小写敏感的精确符号名过滤。 |
| `scope` | 外层优先的作用域过滤，如 `Foo.bar`。 |
| `lang` | 扩展名有歧义时指定语法。 |
| `extended` | 同时报告非声明符号。 |
| `offset` / `limit` | 按**符号**分页，不是按行。 |

## 输出

原生投影里每个符号一行位置：

```text
=== SYMBOLS: good.ts (typescript, 5 symbols) ===
1-3 f alpha
5-13 c Widget
```

回执只有位置与身份（`revision`、`fileHash`），永远没有正文：大纲不能替代一次读取。所以
`symbol_map` 不在 `OBSERVED_READ_TOOLS` 里，只看大纲就去编辑仍然过不了 compare-and-swap。

有语法错误的文件仍会给出错误行以下的符号，且头部标注 `recovered best-effort`，尽力而为的结果不会被当成干净结果。

## 语法包

语法包是可选依赖（`tree-sitter`、`tree-sitter-typescript`、`tree-sitter-javascript`）。缺失时工具
以 `EXECUTOR_UNAVAILABLE` 拒绝并给出确切的安装命令，绝不返回一个“看起来像空文件”的空大纲。
插件被拷出 `node_modules`、自身目录不再位于安装语法的工程下时，用 `DSH_OPS_SYMBOL_MAP_ROOT`
指向工程根。

## 成本

400 行 TypeScript 文件：大纲估算 321 token，整篇读 2 740 token（−88 %）；热态 0.13 ms vs 0.84 ms。
第一次读某个文件要付解析成本（14.7 ms），之后走符号表缓存。

#!/usr/bin/env node
import { runInprocCli } from './inproc.cjs';

const HELP = `ops-ast — 进程内 AST 重构引擎（零外部二进制）

用法:
  ops-ast locate   --symbol <名字> [--roots <目录>] [--ext ts,tsx] [--limit 5] [--strategy auto|walk|everything]
  ops-ast refactor --pattern <AST pattern> --rewrite <模板> [--symbol <名字>] [--file <路径>]
                   [--roots <目录>] [--mode apply|preview] [--limit 1] [--strict]

说明:
  --strategy auto        按目录规模自动选寻址（默认；>1.2 万文件且装了 es.exe 才切 Everything）
  --strategy everything  强制走 es.exe（需本机运行 Everything）
  --strict               落盘前额外用 sg CLI 对账命中数（+36ms，需装 ast-grep）

退出码: 0=成功, 1=业务熔断（见输出里的 code）, 2=参数错误
`;

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    process.stdout.write(HELP);
    process.exit(argv.length === 0 ? 2 : 0);
}
// 无 MCP stdio 子命令：模型可见的工具面必须经宿主可信桥（adapter.cjs）服从
// 宿主权限模型，独立 stdio 端点会绕过它——与 0.3.2 移除 FastCtx 的理由一致。
process.exit(runInprocCli(argv));

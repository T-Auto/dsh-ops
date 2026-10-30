#!/usr/bin/env node
import { runInprocCli } from './inproc';

const HELP = `ops-ptc — 进程内 AST 重构引擎（零外部二进制）

用法:
  ops-ptc locate   --symbol <名字> [--roots <目录>] [--ext ts,tsx] [--limit 5] [--strategy auto|walk|everything]
  ops-ptc refactor --pattern <AST pattern> --rewrite <模板> [--symbol <名字>] [--file <路径>]
                   [--roots <目录>] [--mode apply|preview] [--limit 1] [--strict]
  ops-ptc mcp      # MCP stdio server

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
if (argv[0] === 'mcp') {
    // 惰性加载：--help 那条路径必须能在 MCP server 挂上 stdio 之前就退出
    void import('./mcp.js');
}
else {
    process.exit(runInprocCli(argv));
}

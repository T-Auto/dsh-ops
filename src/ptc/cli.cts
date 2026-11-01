#!/usr/bin/env node
/**
 * The `ops-ptc` command line: locate, refactor, or an MCP stdio server.
 *
 * Exit codes are the contract a shell caller branches on: 0 success, 1 the engine refused for a business
 * reason (the output names the code), 2 bad arguments. `--help` alone is 0; a bare invocation is 2,
 * because "you asked for nothing" is a usage error rather than a successful help dump.
 *
 * @module dsh-ops/ptc/cli
 */

import { runInprocCli } from './inproc.cjs'

const HELP = `ops-ptc — in-process AST refactoring engine (no external binary)

usage:
  ops-ptc locate   --symbol <name> [--roots <dir>] [--ext ts,tsx] [--limit 5] [--strategy auto|walk|everything]
  ops-ptc refactor --pattern <AST pattern> --rewrite <template> [--symbol <name>] [--file <path>]
                   [--roots <dir>] [--mode apply|preview] [--limit 1] [--strict]
  ops-ptc mcp      # MCP stdio server

notes:
  --strategy auto        pick enumeration by tree size (default; Everything only above ~12k files with es.exe)
  --strategy everything  force es.exe (requires Everything running on this host)
  --strict               reconcile hit counts with the sg CLI before writing (+36ms, requires ast-grep)

exit codes: 0=success, 1=business refusal (see code in the output), 2=bad arguments
`

const argv = process.argv.slice(2)

if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
  process.stdout.write(HELP)
  process.exit(argv.length === 0 ? 2 : 0)
}

if (argv[0] === 'mcp') {
  // The MCP server owns the process from here; importing it is the whole action.
  require('./mcp.cjs')
} else {
  process.exit(runInprocCli(argv))
}

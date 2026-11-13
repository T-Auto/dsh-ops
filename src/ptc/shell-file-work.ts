/** Conservative literal-shell classifier: stdin filters are not file access. */
export function shellFileWork(command: string): boolean {
  const tokens = command.replace(/\d*[<>]&(?:\d+|-)/gu, '').match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s|;&<>]+|<<<|<<|>>|[|;&<>]/gu)
  if (!tokens || /[`$]/u.test(command)) return false // Dynamic shell syntax is not a definite accusation.
  let words: string[] = [], piped = false
  const readsFiles = (): boolean => {
    const [raw, ...args] = words
    const name = raw?.toLowerCase()
    if (!name) return false
    if (['ls', 'dir', 'find', 'cp', 'mv', 'rm', 'mkdir', 'get-childitem', 'get-content', 'test-path'].includes(name)) return true
    if (name === 'select-string') return args.some(arg => /^-(?:literalpath|path)$/iu.test(arg))
    if (args.some(arg => arg === '--help' || arg === '--version')) return false
    if (['sed', 'perl'].includes(name) && args.some(arg => /^--in-place(?:=|$)|^-[nEruzpa]*i/u.test(arg))) return true
    if (!['cat', 'type', 'head', 'tail', 'wc', 'grep', 'rg', 'sed', 'awk'].includes(name)) return false
    const operands: string[] = []
    let pattern = !['grep', 'rg', 'sed', 'awk'].includes(name)
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!
      if (arg === '--') { operands.push(...args.slice(index + 1)); break }
      if (arg === '-f' || arg === '--file') return true
      if (arg === '-e' || arg === '--regexp' || arg === '--expression') { pattern = true; index++; continue }
      if (['-n', '-c', '--lines', '--bytes'].includes(arg) && ['head', 'tail'].includes(name)) { index++; continue }
      if (['--include', '--exclude', '--exclude-dir', '-g', '--glob', '-A', '-B', '-C', '-m', '--max-count',
        '--after-context', '--before-context', '--context', '--encoding', '--max-columns', '--threads'].includes(arg)
        || name === 'awk' && ['-F', '-v'].includes(arg)) { index++; continue }
      if (arg.startsWith('-') && arg !== '-') {
        const flags = name === 'sed' ? /^-[nEruz]+$|^--(?:posix|quiet|silent|regexp-extended|unbuffered|zero-terminated)$/u
          : /^(?:-\d+|-[ivnHhclLqsrwFxEoaUzbvet]+|--(?:line-number|ignore-case|invert-match|count|files-with-matches|files-without-match|quiet|silent|recursive|word-regexp|fixed-strings|extended-regexp|only-matching|with-filename|no-filename|color(?:=\w+)?))$/u
        if (flags.test(arg)) continue
        return false
      }
      if (!pattern) pattern = true
      else operands.push(arg)
    }
    return operands.some(arg => arg !== '-') || (name === 'rg' && !piped)
  }
  for (const token of [...tokens, ';']) {
    if (['|', ';', '&', '<', '>', '>>', '<<', '<<<'].includes(token)) {
      if (readsFiles()) return true
      if (token === '<<' || token === '<<<') return false
      if (token === '<' || token === '>' || token === '>>') return true
      words = []; piped = token === '|'
    } else if (token.startsWith('#')) return readsFiles()
    else words.push(token.replace(/^(['"])(.*)\1$/su, '$2'))
  }
  return false
}

/** Only inspect a literal command property belonging to an actual shell call. */
export function literalShellFileWork(code: string, callEnd: number): boolean {
  const args = code.slice(callEnd)
  const command = /^\s*\{(?:\s*(?:description|cwd|timeout_ms)\s*:\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\d+)\s*,)*\s*(?:command|script)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`)/u.exec(args)?.[1]
  return shellLiteralFileWork(command)
}

/** Classify a complete JavaScript string or static template literal. */
export function shellLiteralFileWork(command: string | undefined): boolean {
  if (!command || command.length < 2 || command[0] !== command[command.length - 1]) return false
  if (command.startsWith('`') && command.includes('${')) return false
  let decoded: string
  try { decoded = command.startsWith('"') ? JSON.parse(command) as string : command.slice(1, -1).replace(/\\(['\\])/gu, '$1') }
  catch { return false }
  return shellFileWork(decoded)
}

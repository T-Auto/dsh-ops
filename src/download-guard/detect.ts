/**
 * Detect a shell call that writes downloaded bytes to a local file.
 *
 * WHY THIS IS DETECTION ONLY
 *
 * Deciding what to DO about such a call is a policy question and lives in
 * `./policy.ts`; this module answers one narrow, testable question: given a
 * command string, does it look like a download that lands on disk?
 *
 * FALSE NEGATIVES ARE CHEAPER THAN FALSE POSITIVES
 *
 * Missing a download leaves the status quo: the command runs as it always did.
 * Refusing an ordinary command breaks a working session and is visible to the
 * user. Every rule below therefore requires a WRITE signal — a flag that names
 * an output file — and never fires merely because the text mentions a
 * downloader. That distinction is not theoretical: a rule matching the bare
 * word `download` refused a legitimate `node download.cjs --help`, because in a
 * shell `node download.cjs` and `aria2-dl.js something` are indistinguishable
 * strings.
 *
 * @module dsh-ops/download-guard/detect
 */

/** What matched, and where the bytes appear to be going. */
export interface DownloadHit {
  /** Short machine name of the matched rule, for tests and refusal text. */
  rule: string
  /** The URL the command appears to fetch, when one is visible in the text. */
  url?: string
  /** The local file the command appears to write, when one is visible. */
  target?: string
}

/**
 * Split a command line into sub-commands on unquoted `;`, `&&`, `||`, `|` and
 * newlines, so a download buried after an unrelated `cd` is still examined on
 * its own.
 *
 * Quotes are tracked so a separator inside them does not split: `echo "a;b"`
 * is one sub-command. This is not a full shell parser and does not try to be —
 * it only has to be conservative in the direction that avoids false positives.
 *
 * @param command - the raw command string.
 * @returns one trimmed string per sub-command, separators removed.
 */
export function splitSubcommands(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: 'none' | 'single' | 'double' = 'none'
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string
    if (quote === 'single') {
      current += char
      if (char === "'") quote = 'none'
      continue
    }
    if (quote === 'double') {
      current += char
      if (char === '"') quote = 'none'
      else if (char === '\\' && index + 1 < command.length) {
        current += command[index + 1] as string
        index += 1
      }
      continue
    }
    if (char === "'") { quote = 'single'; current += char; continue }
    if (char === '"') { quote = 'double'; current += char; continue }
    if (char === '\\' && index + 1 < command.length) {
      current += char + (command[index + 1] as string)
      index += 1
      continue
    }
    if (char === ';' || char === '\n') { parts.push(current); current = ''; continue }
    if (char === '&' && command[index + 1] === '&') { parts.push(current); current = ''; index += 1; continue }
    if (char === '|') {
      parts.push(current)
      current = ''
      if (command[index + 1] === '|') index += 1
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map(part => part.trim()).filter(part => part.length > 0)
}

/** Strip a leading `VAR=value` assignment run, which is not the command word. */
function commandWordOf(segment: string): { word: string, rest: string } {
  let rest = segment.trim()
  for (;;) {
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.exec(rest)
    if (assignment === null) break
    rest = rest.slice(assignment[0].length)
  }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest)
  if (match === null) return { word: '', rest: '' }
  return { word: match[1] ?? '', rest: match[2] ?? '' }
}

/**
 * Extract the argument that follows exactly one of `flags`.
 *
 * Both `-o FILE` and `-oFILE` spellings are accepted, and `--long=FILE` too,
 * because all three appear in real usage. A repeated flag must resolve to the
 * LAST occurrence, because that is the one the tool honours.
 *
 * A value of `-` is returned as-is: callers decide what it means, because for
 * curl and wget it means stdout rather than a file.
 *
 * @param args - the argument tail of a sub-command.
 * @param flags - short and long spellings to look for, e.g. `['-o', '--output']`.
 * @returns the value when one is found.
 */
function flagValue(args: string[], flags: readonly string[]): string | undefined {
  let found: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    for (const flag of flags) {
      if (arg === flag) {
        const next = args[index + 1]
        // A leading `-` normally means the next option, not a value; `-` alone
        // is the documented stdout sentinel and must be taken literally.
        if (next !== undefined && (next === '-' || !next.startsWith('-'))) found = next
        continue
      }
      if (arg.startsWith(`${flag}=`)) { found = arg.slice(flag.length + 1); continue }
      // A short flag may carry its value with no separator: -oFILE.
      if (flag.length === 2 && arg.startsWith(flag) && arg.length > 2) found = arg.slice(2)
    }
  }
  return found !== undefined && found !== '' ? found : undefined
}

/** First `http://` or `https://` token in the segment, if any. */
function urlOf(segment: string): string | undefined {
  const match = /(https?:\/\/[^\s"'`]+)/i.exec(segment)
  return match?.[1]
}

/** A trailing `> FILE` / `>> FILE` redirect target, when present. */
function redirectTargetOf(segment: string): string | undefined {
  const match = /(?:^|[^>\d])>{1,2}\s*(?![&|])([^\s;|&]+)/.exec(segment)
  const target = match?.[1]
  if (target === undefined) return undefined
  return target === '/dev/null' || target === 'nul' || target === '$null' ? undefined : target
}

/**
 * Whether the sub-command fetches over the network at all.
 *
 * Used only to decide whether a redirect target is worth reporting; the
 * refusal itself is driven by the presence of a write flag.
 *
 * @param segment - one sub-command.
 * @returns true when a URL or a known downloader appears.
 */
function fetchesNetwork(segment: string): boolean {
  return urlOf(segment) !== undefined || /\b(curl|wget)\b/i.test(segment)
}

/** Quote-aware split of an argument tail into tokens. */
function argumentsOf(rest: string): string[] {
  const match = rest.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
  return match ?? []
}

/**
 * Inspect one sub-command.
 *
 * @param segment - one sub-command from {@link splitSubcommands}.
 * @returns the hit, or undefined when the command does not write a download.
 */
export function inspectSegment(segment: string): DownloadHit | undefined {
  const { word, rest } = commandWordOf(segment)
  if (word === '') return undefined
  const base = word.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()
  const args = argumentsOf(rest)

  // curl: -o / --output names a file; -O / --remote-name derives the name from
  // the URL but still lands one. A bare `curl URL` prints to stdout, so it is
  // NOT a download and must stay allowed.
  if (base === 'curl') {
    const output = flagValue(args, ['-o', '--output'])
    // `-o -` streams to stdout; nothing lands on disk.
    if (output !== undefined && output !== '-') return { rule: 'curl-output', url: urlOf(segment), target: output }
    const remoteName = args.some(arg => arg === '-O' || arg === '--remote-name'
      || arg === '--remote-name-all' || /^-[A-Za-z]*O[A-Za-z]*$/.test(arg))
    if (remoteName) return { rule: 'curl-remote-name', url: urlOf(segment) }
    const redirect = redirectTargetOf(segment)
    if (redirect !== undefined && fetchesNetwork(segment)) {
      return { rule: 'redirect', url: urlOf(segment), target: redirect }
    }
    return undefined
  }

  // wget writes to a file by design; -O names it, -q only silences progress.
  if (base === 'wget') {
    const output = flagValue(args, ['-O', '--output-document'])
    if (output !== undefined) return { rule: 'wget', url: urlOf(segment), target: output }
    // `-O -` means stdout, not a file. It is the documented way to stream
    // wget into a pipe (`wget -qO- URL | tar xz`), so it must stay allowed.
    if (args.some(arg => arg === '-O-' || arg === '--output-document=-'
      || /^-[A-Za-z]*O-$/.test(arg))) return undefined
    const redirect = redirectTargetOf(segment)
    if (redirect !== undefined) return { rule: 'wget', url: urlOf(segment), target: redirect }
    // A bare `wget URL` still lands a file in the working directory.
    if (urlOf(segment) !== undefined) return { rule: 'wget', url: urlOf(segment) }
    return undefined
  }

  // PowerShell downloaders: only the *OutFile / -Destination spellings write a
  // named file. `Invoke-RestMethod` without one returns a parsed object, which
  // is not a download.
  if (base === 'invoke-webrequest' || base === 'iwr') {
    const output = flagValue(args, ['-OutFile'])
    return output === undefined ? undefined : { rule: 'Invoke-WebRequest', url: urlOf(segment), target: output }
  }
  if (base === 'invoke-restmethod' || base === 'irm') {
    const output = flagValue(args, ['-OutFile'])
    return output === undefined ? undefined : { rule: 'Invoke-RestMethod', url: urlOf(segment), target: output }
  }
  if (base === 'start-bitstransfer') {
    const output = flagValue(args, ['-Destination'])
    return output === undefined ? undefined : { rule: 'Start-BitsTransfer', url: urlOf(segment), target: output }
  }
  return undefined
}

/**
 * Inspect a whole command line, sub-command by sub-command.
 *
 * @param command - the raw `command` argument of a shell tool call.
 * @returns the first download hit, or undefined.
 */
export function inspectCommand(command: unknown): DownloadHit | undefined {
  if (typeof command !== 'string' || command.trim() === '') return undefined
  for (const segment of splitSubcommands(command)) {
    const hit = inspectSegment(segment)
    if (hit !== undefined) return hit
  }
  return undefined
}

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isolatedGitEnv, runCommand, type Runner } from './process.js'

export interface MergeProbe { status: 'clean' | 'conflicts' | 'unknown'; tree?: string; files?: string[]; reason?: string }
const oid = (value: string) => /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(value)

/** Read only the source object store. All generated objects/config live in a disposable bare repo. */
export async function probeMerge(checkout: string | undefined, base: string, head: string,
  signal?: AbortSignal, run: Runner = runCommand): Promise<MergeProbe> {
  if (!checkout) return { status: 'unknown', reason: 'No --checkout supplied; no local merge probe.' }
  if (!oid(base) || !oid(head)) return { status: 'unknown', reason: 'Exact commit object IDs are unavailable.' }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ops-review-'))
  try {
    const empty = path.join(temporary, 'empty'), bare = path.join(temporary, 'probe.git')
    await fs.writeFile(empty, '')
    const env = isolatedGitEnv(empty)
    const source = await run('git', ['-C', path.resolve(checkout), 'rev-parse', '--path-format=absolute', '--git-common-dir'], { env, signal })
    const common = source.stdout.trim()
    if (source.code !== 0 || !path.isAbsolute(common) || /[\r\n]/.test(common)) return { status: 'unknown', reason: 'Cannot locate the checkout object store.' }
    const template = path.join(temporary, 'template')
    await fs.mkdir(template)
    const initialized = await run('git', ['init', '--bare', `--template=${template}`, bare], { env, signal })
    if (initialized.code !== 0) return { status: 'unknown', reason: initialized.stderr || 'Cannot initialize isolated merge probe.' }
    await fs.writeFile(path.join(bare, 'objects/info/alternates'), `${path.join(common, 'objects').replaceAll('\\', '/')}\n`)
    const args = ['--git-dir', bare, '-c', `core.hooksPath=${template}`, '-c', `core.attributesFile=${empty}`]
    for (const commit of [base, head]) {
      const present = await run('git', [...args, 'cat-file', '-e', `${commit}^{commit}`], { env, signal })
      if (present.code !== 0) return { status: 'unknown', reason: `Commit ${commit} is not available locally; no fetch was attempted.` }
    }
    const result = await run('git', [...args, 'merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', base, head], { env, signal })
    if (result.code !== 0 && result.code !== 1) return { status: 'unknown', reason: result.stderr || 'Merge probe unavailable.' }
    const [tree, ...names] = result.stdout.split('\0')
    const files = names.filter(Boolean)
    if (!oid(tree ?? '') || files.length > 100 || files.some(file => file.length > 500)) return { status: 'unknown', reason: 'Merge output exceeded the supported bounds.' }
    if (result.code === 0 && files.length !== 0) return { status: 'unknown', reason: 'Unexpected clean-merge output.' }
    return { status: result.code === 0 ? 'clean' : 'conflicts', tree, files }
  } catch (error) {
    return { status: 'unknown', reason: String(error instanceof Error ? error.message : error).slice(0, 500) }
  } finally { await fs.rm(temporary, { recursive: true, force: true }) }
}

/**
 * The per-call Niubash execution tree: a hardlink clone of the immutable
 * distribution, plus its stat-only verification.
 *
 * The old preparation copied 107.63 MiB and then materialized 153 argv0 faces by
 * copying `winuxcmd.exe` 153 times, writing 785.75 MiB per call. A clone by
 * `fs.link` writes no file data at all: every payload name and every face share
 * the one source inode. When the execution root lives on another volume (or the
 * filesystem refuses hardlinks) the whole tree falls back to `copyFile`, and the
 * execution receipt records which mode ran.
 *
 * Verification is stat-only. The compiled manifest authorizes bytes once, at
 * installation/selection time ({@link verifyNiubashTree} in the payload module);
 * a running call compares the path set, every file size, the directory set, the
 * read-only seal and the link counts recorded at creation. It reads zero payload
 * bytes, which is what removes the old 1.85 GiB of SHA-256 per call. The
 * `NIUBASH_VERIFY=deep` escape hatch restores a full re-hash for operators who
 * want it.
 *
 * Every filesystem call is injected through {@link TreeOps}, so a synthetic tree
 * can prove hardlink cloning, EXDEV fallback, cancellation and every rejection
 * on a platform that cannot run the Windows payload itself.
 *
 * @module dsh-ops/niubash/execution-tree
 */

import fs from 'node:fs'
import path from 'node:path'

/** The filesystem calls cloning and verification need. */
export interface TreeOps {
  mkdir(directory: string): Promise<void>
  readdir(directory: string): Promise<fs.Dirent[]>
  lstat(file: string): Promise<fs.Stats>
  link(source: string, target: string): Promise<void>
  copyFile(source: string, target: string): Promise<void>
  readFile(file: string): Promise<string>
  rm(directory: string): Promise<void>
}

export const nodeTreeOps: TreeOps = {
  mkdir: async (directory) => { await fs.promises.mkdir(directory, { recursive: true }) },
  readdir: (directory) => fs.promises.readdir(directory, { withFileTypes: true }),
  lstat: (file) => fs.promises.lstat(file),
  link: (source, target) => fs.promises.link(source, target),
  copyFile: (source, target) => fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL),
  readFile: (file) => fs.promises.readFile(file, 'utf8'),
  rm: (directory) => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
}

/** `hardlink` when the clone shares source inodes, `copy` after an EXDEV fallback. */
export type CloneMode = 'hardlink' | 'copy'

/** What the execution tree must contain, in relative-path terms. */
export interface TreeInventory {
  /** Immutable distribution files: relative path -> expected byte size. */
  files: Readonly<Record<string, number>>
  /** argv0 faces: target relative path -> the relative file it is linked from. */
  derived: Readonly<Record<string, string>>
  /** Directories the payload itself owns. */
  directories: readonly string[]
  /** Fresh writable state directories created for this call only. */
  stateDirectories: readonly string[]
  /** Additional immutable files copied from the source (its provenance receipt). */
  extra: readonly string[]
}

export interface CloneRequest extends TreeInventory {
  /** The verified source payload root. */
  source: string
  /** The fresh, empty execution root. */
  root: string
  signal?: AbortSignal
  ops?: Partial<TreeOps>
}

/** The created tree, recorded for the stat-only check that runs before spawn. */
export interface CloneResult {
  mode: CloneMode
  /** Expected byte size for every relative path in the tree. */
  sizes: Record<string, number>
  /** Expected link count for every relative path, captured after creation. */
  links: Record<string, number>
  /** File data actually written into the tree; zero for a hardlink clone. */
  dataBytes: number
}

const CROSS_DEVICE_CODES = new Set(['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'EPERM'])

function isCrossDeviceLinkFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && CROSS_DEVICE_CODES.has(String((error as NodeJS.ErrnoException).code))
}

function mergeOps(ops: Partial<TreeOps> | undefined): TreeOps {
  return { ...nodeTreeOps, ...ops }
}

/**
 * Clone the immutable distribution into `root`, materialize the argv0 faces and
 * create the writable state directories. Returns the sizes and link counts the
 * later stat-only check must see, plus the clone mode and copied data bytes.
 */
export async function cloneExecutionTree(request: CloneRequest): Promise<CloneResult> {
  const ops = mergeOps(request.ops)
  const { source, root, signal } = request
  const sizes: Record<string, number> = { ...request.files }
  for (const name of request.extra) sizes[name] = (await ops.lstat(path.join(source, name))).size
  for (const [target, origin] of Object.entries(request.derived)) {
    const size = sizes[origin]
    if (size === undefined) throw Error(`Invalid Niubash execution tree derivation: ${target}`)
    sizes[target] = size
  }
  const directories = [...new Set([...request.directories, ...request.stateDirectories])]
  const createDirectories = async () => {
    await ops.mkdir(root)
    for (const directory of directories) await ops.mkdir(path.join(root, directory))
  }
  const place = async (mode: CloneMode, from: string, to: string) => {
    if (mode === 'hardlink') await ops.link(from, to)
    else await ops.copyFile(from, to)
  }
  const materialize = async (mode: CloneMode) => {
    for (const name of Object.keys(request.files)) {
      signal?.throwIfAborted()
      await place(mode, path.join(source, name), path.join(root, name))
    }
    for (const name of request.extra) {
      signal?.throwIfAborted()
      await place(mode, path.join(source, name), path.join(root, name))
    }
    for (const [target, origin] of Object.entries(request.derived)) {
      signal?.throwIfAborted()
      await place(mode, path.join(root, origin), path.join(root, target))
    }
  }

  await createDirectories()
  let mode: CloneMode = 'hardlink'
  try {
    await materialize('hardlink')
  } catch (error) {
    if (!isCrossDeviceLinkFailure(error)) throw error
    signal?.throwIfAborted()
    // A partial hardlink clone cannot be converted in place; rebuild the tree as
    // copies, which is the documented cross-device fallback.
    await ops.rm(root)
    await createDirectories()
    mode = 'copy'
    await materialize('copy')
  }

  const links: Record<string, number> = {}
  for (const name of Object.keys(sizes)) {
    signal?.throwIfAborted()
    links[name] = (await ops.lstat(path.join(root, name))).nlink
  }
  const dataBytes = mode === 'copy' ? Object.values(sizes).reduce((total, size) => total + size, 0) : 0
  return { mode, sizes, links, dataBytes }
}

/** One stat-only walk of a tree, rejecting links and special files. */
export interface TreeListing {
  files: Map<string, fs.Stats>
  directories: string[]
}

export interface TreeReadOptions {
  signal?: AbortSignal
  ops?: Partial<TreeOps>
}

export async function readTree(root: string, options: TreeReadOptions = {}): Promise<TreeListing> {
  const ops = mergeOps(options.ops)
  const stat = await ops.lstat(root)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error(`Unsafe Niubash tree root: ${root}`)
  const files = new Map<string, fs.Stats>()
  const directories: string[] = []
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await ops.readdir(path.join(root, relative))) {
      options.signal?.throwIfAborted()
      const name = relative === '' ? entry.name : `${relative}/${entry.name}`
      const file = path.join(root, name)
      const stats = await ops.lstat(file)
      if (stats.isSymbolicLink()) throw Error(`Unsafe Niubash tree member: ${name}`)
      if (stats.isDirectory()) { directories.push(name); await visit(name) }
      else if (stats.isFile()) files.set(name, stats)
      else throw Error(`Unsafe Niubash tree member: ${name}`)
    }
  }
  await visit('')
  return { files, directories }
}

/** What a stat-only verification expects to see. */
export interface TreeExpectation {
  /** Expected byte size per relative file path. */
  sizes: Readonly<Record<string, number>>
  /** Expected link count per relative file path. */
  links?: Readonly<Record<string, number>>
  /** The complete allowed directory set, relative to the root. */
  directories: readonly string[]
  /** Whether every file must have lost its write bits. */
  sealed: boolean
}

export interface TreeVerifyRequest extends TreeExpectation {
  root: string
  signal?: AbortSignal
  ops?: Partial<TreeOps>
}

/**
 * Compare a tree with a recorded expectation without reading one payload byte:
 * path set, sizes, directory set, seal and link counts only. Every deviation is
 * fail-closed; the caller does not retry a changed tree.
 */
export async function verifyTreeStat(request: TreeVerifyRequest): Promise<void> {
  const listing = await readTree(request.root, { signal: request.signal, ops: request.ops })
  const directories = new Set(request.directories)
  for (const directory of listing.directories) {
    if (!directories.has(directory)) throw Error(`Unknown Niubash execution directory: ${directory}`)
  }
  for (const [name, stat] of listing.files) {
    if (!Object.hasOwn(request.sizes, name)) throw Error(`Unsafe Niubash execution tree member: ${name}`)
    if (stat.size !== request.sizes[name]) throw Error(`Niubash execution tree size mismatch: ${name}`)
    if (request.sealed && (stat.mode & 0o222) !== 0) throw Error(`Niubash execution tree member is not sealed: ${name}`)
    const expectedLinks = request.links?.[name]
    if (expectedLinks !== undefined && stat.nlink !== expectedLinks) throw Error(`Niubash execution tree link count mismatch: ${name}`)
  }
  if (listing.files.size !== Object.keys(request.sizes).length) throw Error('Incomplete Niubash execution tree')
  if (listing.directories.length !== directories.size) throw Error('Incomplete Niubash execution tree')
}

/**
 * Confirm the recorded execution receipt still names this exact tree. The
 * receipt is metadata, so reading it does not weaken the stat-only promise.
 */
export async function verifyExecutionReceipt(root: string, name: string, expected: Record<string, unknown>,
  options: { ops?: Partial<TreeOps> } = {}): Promise<void> {
  const ops = mergeOps(options.ops)
  let actual: unknown
  try { actual = JSON.parse(await ops.readFile(path.join(root, name))) } catch { throw Error(`Invalid Niubash execution receipt: ${name}`) }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(`Invalid Niubash execution receipt: ${name}`)
}

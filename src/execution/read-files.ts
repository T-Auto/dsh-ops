import path from 'node:path'

type Descriptor = Record<string, unknown> & { path: string }
type ResolvedReads = { files: Descriptor[] } | { error: string }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Resolve every range against this invocation's cwd; retain unknown fields for kernel validation. */
export function resolveReadFiles(args: unknown, cwd: string): ResolvedReads {
  if (!record(args) || !Array.isArray(args.files) || args.files.length < 1 || args.files.length > 32) {
    return { error: 'files must contain 1-32 file ranges.' }
  }
  const files: Descriptor[] = []
  for (const [index, input] of args.files.entries()) {
    if (!record(input) || typeof input.path !== 'string' || input.path.length === 0 || input.path.includes('\0')) {
      return { error: `files[${index}].path must be a non-empty path.` }
    }
    const file: Descriptor = { ...input, path: path.resolve(cwd, input.path) }
    for (const key of ['offset', 'limit']) if (file[key] === null || file[key] === undefined) delete file[key]
    files.push(file)
  }
  return { files }
}

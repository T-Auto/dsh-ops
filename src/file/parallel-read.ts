/**
 * Typed door to the parallel file reader, ported into `src/file/reader/*.cts`.
 *
 * The shipped declaration file is kept as `ops_parallel_read.d.cts`; the ported `.cts` modules are
 * runtime-identical to 4.1.8 and carry `@ts-nocheck` until they are re-typed, so this door surfaces
 * them as `any` and the migration stays structural first, typed second.
 *
 * @module dsh-ops/file/parallel-read
 */
import { createRequire } from 'node:module'

const reader: Record<string, any> = createRequire(import.meta.url)('./reader/ops_parallel_read.cjs') as Record<string, any>

export const parallelRead = reader.parallelRead
export const ops_parallel_read = reader.ops_parallel_read
export const readFilesCompat = reader.readFilesCompat
export const ops_read_files = reader.ops_read_files
export const runPool = reader.runPool
export const truncate = reader.truncate
export const OpsError = reader.OpsError
export const DEFAULTS = reader.DEFAULTS
export const TRUNCATED_MARK = reader.TRUNCATED_MARK

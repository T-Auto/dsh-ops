/**
 * Typed entry to the parallel file reader shipped as `engine/parallel-read/`.
 *
 * The engine is plain CommonJS with a hand-written declaration file, kept outside `src/` on purpose:
 * `scripts/build.mjs` refuses JavaScript under `src/`, and rewriting a shipped, independently
 * tested reader into TypeScript would fork it from the artifact the standalone package publishes.
 * This module is the one import site the plugin uses, so the engine has a single typed door and
 * `lib/` links it at `engine/parallel-read/` in the published tree.
 *
 * The names are listed rather than re-exported wholesale: `export *` from a CommonJS module also
 * publishes whatever the loader infers (including a `module.exports` key), and the plugin's public
 * surface should be a decision, not an accident.
 *
 * @module dsh-ops/file/parallel-read
 */
export {
  parallelRead,
  ops_parallel_read,
  readFilesCompat,
  ops_read_files,
  runPool,
  truncate,
  OpsError,
  DEFAULTS,
  TRUNCATED_MARK,
} from '../../engine/parallel-read/ops_parallel_read.js'

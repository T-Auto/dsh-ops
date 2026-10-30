import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

/** Never reuse a corpus or a previous benchmark's output directory. */
export function createRunDirectory(name) {
  const parent = resolve(process.env.PTC_BENCH_OUT ?? tmpdir());
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, `dsh-refactor-${name}-`));
}

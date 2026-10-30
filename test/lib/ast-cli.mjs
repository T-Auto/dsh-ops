import { createRequire } from 'node:module';
import { dirname, join, delimiter } from 'node:path';
import { existsSync } from 'node:fs';

// Resolve the locked native payload directly: npm ci --ignore-scripts deliberately
// does not run @ast-grep/cli's postinstall wrapper generation.
const require = createRequire(import.meta.url);
const suffix = process.platform === 'win32' ? '-msvc' : process.platform === 'linux' ? '-gnu' : '';
const packageName = `@ast-grep/cli-${process.platform}-${process.arch}${suffix}`;
const directory = dirname(require.resolve(`${packageName}/package.json`));
const executable = join(directory, process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep');
if (!existsSync(executable)) throw new Error(`Missing locked AST CLI: ${executable}`);
process.env.PTC_SG = executable;
process.env.PATH = `${directory}${delimiter}${process.env.PATH ?? ''}`;

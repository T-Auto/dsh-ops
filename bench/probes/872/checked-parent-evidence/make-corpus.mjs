/** Create the explicit native-search fixture in a new directory only. */
import fs from 'node:fs'
import path from 'node:path'
if (process.argv.length !== 3) throw Error('Usage: node make-corpus.mjs NEW_DIRECTORY')
const root = path.resolve(process.argv[2])
fs.mkdirSync(root)
for (let i = 0; i < 2000; i++) {
  fs.writeFileSync(path.join(root, `file${i}.ts`), `export const value${i} = 'hit';\n`)
}
console.log(root)

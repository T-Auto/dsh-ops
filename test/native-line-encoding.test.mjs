import { encodeSourceLine } from '../lib/file/native/line-encoding.js'
import { renderNative } from '../lib/file/native/render.js'
import { assert, report, test } from './lib/harness.mjs'
import path from 'node:path'
// Use the independent platform JSON decoder, not a copy of the source encoder.
const decode = line => JSON.parse('"' + line.replaceAll('"', '\\"') + '"')
const pairs = [['\t', '\\t'], ['\r', '\\r'], ['\n', '\\n'], ['\0', '\\u0000'], ['\x7f', '\\u007f'], ['\u0085', '\\u0085'], ['\u2028', '\\u2028'], ['\u2029', '\\u2029']]
const samples = [...pairs.flat(), String.fromCharCode(...Array.from({length:128},(_,i)=>i)), '\\"路径\\😀"', '  ordinary source  ']
await test('source line escapes are injective for controls and literal backslash sequences', () => {
  for (const [control, literal] of pairs) assert.notEqual(encodeSourceLine(control), encodeSourceLine(literal))
  for (const source of samples) {
    const encoded = encodeSourceLine(source)
    assert.equal(decode(encoded), source)
    assert.doesNotMatch(encoded, /[\r\n\t\x00-\x1f\x7f\u0085\u2028\u2029]/)
  }
})
await test('compact and general Native readers retain independently decodable exact source without changing canonical data', () => {
  const file = path.resolve('source.txt')
  for (const source of samples) {
    const value = {status:'completed',path:file,revision:'a'.repeat(64),lineCount:1,nextOffset:2,complete:true,truncated:false,failed:0,items:[{path:file,line:1,text:source}]}
    const batch = {status:'completed',total:1,nextIndex:1,pending:0,failed:0,truncated:false,items:[value]}
    const before = JSON.stringify(batch)
    for(const text of [renderNative('inspect_local_file',{path:file,limit:1},value),renderNative('read_files',{files:[{path:file,limit:1}]},batch)]) {
      const body = text.split('\n').filter(line=>/^1(?: \| |\|)/.test(line))
      assert.equal(body.length,1)
      assert.equal(decode(body[0].replace(/^1(?: \| |\|)/,'')),source)
    }
    assert.equal(JSON.stringify(batch),before)
  }
})
report('native-line-encoding')

/** Build the host's lazy CommonJS browser entry from already type-checked modules. */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
const external = new Set(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'])
export function bundleClient(root) {
  const output = path.join(root, 'lib'), entry = 'client/index.js'
  if (!fs.existsSync(path.join(output, entry))) return
  const modules = new Map(), visiting = new Set()
  function collect(id) {
    if (visiting.has(id)) throw new Error(`Browser module cycle: ${id}`)
    if (modules.has(id)) return
    if (id.startsWith('../') || path.posix.isAbsolute(id) || !id.endsWith('.js')) throw new Error(`Invalid browser module: ${id}`)
    visiting.add(id)
    const source = fs.readFileSync(path.join(output, id), 'utf8')
    const compiled = ts.transpileModule(source, { fileName: id, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, allowJs: true,
    } }).outputText
    const tree = ts.createSourceFile(id, compiled, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
    const imports = {}
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) throw new Error(`Dynamic browser import in ${id}`)
        const request = node.arguments[0].text
        if (request.startsWith('.')) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(id), request))
          imports[request] = target
          collect(target)
        } else if (!external.has(request)) throw new Error(`Unsupported browser external ${request} in ${id}`)
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error(`Dynamic browser import in ${id}`)
      ts.forEachChild(node, visit)
    }
    visit(tree)
    visiting.delete(id)
    modules.set(id, { compiled, imports })
  }
  collect(entry)
  const definitions = [...modules].map(([id, value]) => `${JSON.stringify(id)}:{imports:${JSON.stringify(value.imports)},run(module,exports,require){\n${value.compiled}\n}}`).join(',\n')
  const code = `window.__ModuleLoader__.load({id:"dsh-ops",factory:(require)=>{\nconst modules={${definitions}};\nconst cache=Object.create(null);\nfunction load(id){if(cache[id])return cache[id].exports;const entry=modules[id];if(!entry)throw new Error("Unknown OPS browser module: "+id);const module={exports:{}};cache[id]=module;entry.run(module,module.exports,request=>Object.hasOwn(entry.imports,request)?load(entry.imports[request]):require(request));return module.exports;}\nreturn load(${JSON.stringify(entry)});\n}});\n`
  fs.writeFileSync(path.join(output, 'client.js'), code)
  console.log(`build: bundled ${modules.size} browser modules (${Buffer.byteLength(code)} bytes)`)
}

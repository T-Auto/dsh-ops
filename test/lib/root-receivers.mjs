/**
 * Which call sites receive a capability from the composition root.
 *
 * Type aware on purpose: a text match over `ctx.root` cannot tell a receiver
 * from a WeakMap key, a service read or an owner key, and the natural refactor
 * that collapses an alias back into one expression walks straight past it.
 * The analysis stays inside one file - a root passed across a module boundary
 * is not followed; the runtime suites cover that side.
 */
import path from 'node:path'
import ts from 'typescript'
import { PACKAGE_ROOT } from './harness.mjs'
export const CAPABILITIES = new Set(['on', 'once', 'register', 'unregister', 'effect', 'inject', 'plugin'])

/**
 * Receiver analysis, not a text grep.
 *
 * A capability call is a hit when its receiver resolves to the composition root:
 * the root expression itself (`ctx.root`, `ctx.root.fiber`, `ctx.root.reflect`),
 * a local bound to it (`const root = ctx.root ?? ctx`, `const { root } = ctx`,
 * `const target = root`, `let r; r = ctx.root`), or a helper parameter a call
 * site fills with one. A root value that is only an argument — a WeakMap key,
 * `ctx.get`, a call-budget owner — never has this receiver shape, which is what
 * keeps those reads legal.
 *
 * The compiler does the reading because the spellings real code uses for the
 * root are several: a parenthesized `??`, an optional chain, a bracket key, an
 * object destructuring pattern, an `as` cast, a non-null assertion, an alias hop
 * and a helper parameter are all one receiver once the syntax tree says so. The
 * text regex this replaced missed one of the spellings the fixtures pin.
 *
 * @param sourceFile - a file from the program, or a fixture parsed on its own.
 * @returns capability calls whose receiver is the composition root.
 */
export function rootReceivers(sourceFile) {
  const context = { sourceFile, bindings: bindingsOf(sourceFile), rootParameters: new Set() }
  learnRootParameters(context)
  const hits = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const capability = capabilityCall(context, node.expression)
      if (capability) {
        hits.push({
          receiver: capability.receiver.getText(sourceFile).replace(/\s+/g, ''),
          method: capability.method,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return hits
}

/** A fixture string, parsed in memory: no file is written and no program is built. */
export function hitsFor(text) {
  return rootReceivers(ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS))
}

/** Strip the wrappers that do not change which value an expression denotes. */
function unwrap(node) {
  let current = node
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
      || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression
      continue
    }
    return current
  }
}

/** The text of a string-literal key, or undefined when the key is computed. */
function literalKey(node) {
  const key = unwrap(node)
  if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) return key.text
  return undefined
}

/** The node a new binding belongs to: the nearest enclosing block or the file. */
function bindingScope(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isSourceFile(current) || ts.isBlock(current) || ts.isModuleBlock(current) || ts.isCaseClause(current)) return current
  }
  return node.getSourceFile()
}

/**
 * Every local binding in one file, by the identifier the code refers to them by.
 *
 * A destructured binding remembers the key it came from, so `const { root } = ctx`
 * and `const { root: alias } = ctx` both read as "this name is the root". A name
 * declared without a value and assigned later (`let r; r = ctx.root`) is indexed
 * once per assignment, so the use resolves to the value that is actually there
 * instead of to an empty declaration.
 * @param sourceFile - the file to index.
 * @returns bindings grouped by the name they are read by.
 */
function bindingsOf(sourceFile) {
  const bindings = new Map()
  const add = (name, binding) => {
    const existing = bindings.get(name)
    if (existing) existing.push(binding)
    else bindings.set(name, [binding])
  }
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      add(node.name.text, { scope: bindingScope(node), pos: node.getStart(sourceFile), initializer: node.initializer })
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      // `const { root } = ctx` names the key with an identifier; a computed key
      // (`const { [name]: bound } = ctx`) is not a name this analysis can read.
      const written = node.propertyName ?? node.name
      add(node.name.text, {
        scope: bindingScope(node), pos: node.getStart(sourceFile),
        key: ts.isIdentifier(written) ? written.text : literalKey(written),
      })
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      add(node.name.text, { scope: node.parent, pos: node.getStart(sourceFile), initializer: node.initializer, parameter: node })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  // A plain assignment points the name at a value too, so it is indexed the same
  // way a declaration is: `let r; r = ctx.root` then resolves the use that
  // follows it to the assignment rather than to the empty declaration.
  const visitAssignments = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      add(node.left.text, { scope: bindingScope(node), pos: node.getStart(sourceFile), initializer: node.right })
    }
    ts.forEachChild(node, visitAssignments)
  }
  visitAssignments(sourceFile)
  return bindings
}

/**
 * The binding an identifier refers to: the innermost scope that encloses the use
 * and declares or assigns the name no later than the use. When a name is declared
 * and then assigned again, the latest binding before the use wins, so a use sees
 * the value that is actually there at that point. Branches are not simulated: a
 * name assigned the root inside one branch still reads as root after it, which is
 * the may-have-been shape this check wants to report.
 * @param context - the analysis context.
 * @param identifier - the identifier being read.
 * @returns the binding, or undefined when the name is not a local.
 */
function bindingFor(context, identifier) {
  const candidates = context.bindings.get(identifier.text)
  if (!candidates) return undefined
  const enclosing = new Set()
  for (let current = identifier.parent; current; current = current.parent) enclosing.add(current)
  const use = identifier.getStart(context.sourceFile)
  let found
  for (const candidate of candidates) {
    if (!enclosing.has(candidate.scope) || candidate.pos > use) continue
    if (!found || candidate.pos > found.pos) found = candidate
  }
  return found
}

/**
 * Whether an expression is the composition root, or is derived from it.
 *
 * Property and element access stay derived (`ctx.root.fiber`), so a receiver
 * chain is judged by the hop that names the root; `??`, `||` and a conditional
 * stay derived on either side, because both branches denote the same receiver.
 * @param context - the analysis context.
 * @param node - the expression to judge.
 * @param seen - guards against an alias cycle.
 * @returns true when the expression denotes the composition root.
 */
function fromRoot(context, node, seen = new Set()) {
  const expression = unwrap(node)
  if (seen.has(expression)) return false
  seen.add(expression)
  if (ts.isIdentifier(expression)) {
    const binding = bindingFor(context, expression)
    if (!binding) return false
    if (binding.key !== undefined) return binding.key === 'root'
    if (binding.parameter !== undefined && context.rootParameters.has(binding.parameter)) return true
    return binding.initializer !== undefined && fromRoot(context, binding.initializer, seen)
  }
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === 'root' || fromRoot(context, expression.expression, seen)
  if (ts.isElementAccessExpression(expression)) return literalKey(expression.argumentExpression) === 'root' || fromRoot(context, expression.expression, seen)
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind
    if (operator !== ts.SyntaxKind.QuestionQuestionToken && operator !== ts.SyntaxKind.BarBarToken
      && operator !== ts.SyntaxKind.AmpersandAmpersandToken) return false
    return fromRoot(context, expression.left, new Set(seen)) || fromRoot(context, expression.right, new Set(seen))
  }
  if (ts.isConditionalExpression(expression)) {
    return fromRoot(context, expression.whenTrue, new Set(seen)) || fromRoot(context, expression.whenFalse, new Set(seen))
  }
  return false
}

/**
 * Learn which helper parameters receive the root.
 *
 * A helper that subscribes for its caller (`function subscribe(target) { target.on(...) }`)
 * hides the receiver behind a parameter, so the call sites decide. The loop
 * repeats because one helper may hand the root on to another.
 * @param context - the analysis context, whose `rootParameters` is extended.
 * @returns void
 */
function learnRootParameters(context) {
  const sourceFile = context.sourceFile
  const helpers = new Map()
  const remember = (name, node) => {
    const existing = helpers.get(name)
    if (existing) existing.push(node)
    else helpers.set(name, [node])
  }
  const collect = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) remember(node.name.text, node)
    else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) remember(node.name.text, node)
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer))) remember(node.name.text, node.initializer)
    else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)
      && (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer))) remember(node.name.text, node.initializer)
    ts.forEachChild(node, collect)
  }
  collect(sourceFile)
  const calls = []
  const gather = (node) => {
    if (ts.isCallExpression(node)) calls.push(node)
    ts.forEachChild(node, gather)
  }
  gather(sourceFile)
  for (let round = 0; round < 8; round += 1) {
    const learned = seedParameters(context, helpers, calls)
    if (!learned) return
  }
}

/**
 * Mark one round of helper parameters as root-carrying.
 * @param context - the analysis context, whose `rootParameters` is extended.
 * @param helpers - every function-like declaration in the file, by name.
 * @param calls - every call in the file.
 * @returns whether this round learned anything new.
 */
function seedParameters(context, helpers, calls) {
  let learned = false
  for (const call of calls) {
    const callee = unwrap(call.expression)
    const targets = ts.isIdentifier(callee) ? helpers.get(callee.text)
      : ts.isPropertyAccessExpression(callee) ? helpers.get(callee.name.text)
      : undefined
    if (!targets) continue
    for (const target of targets) {
      const shared = Math.min(call.arguments.length, target.parameters.length)
      for (let index = 0; index < shared; index += 1) {
        const parameter = target.parameters[index]
        if (!ts.isIdentifier(parameter.name) || context.rootParameters.has(parameter)) continue
        if (!fromRoot(context, call.arguments[index])) continue
        context.rootParameters.add(parameter)
        learned = true
      }
    }
  }
  return learned
}

/**
 * Read a call as a capability call, when it is one.
 *
 * Three spellings carry the same method: `x.on(...)`, `x['on'](...)` and
 * `Reflect.get(x, 'on')(...)`. A computed key is not a name this analysis can
 * resolve, so those calls are left alone (the suite states the limitation).
 * @param context - the analysis context.
 * @param callee - the call's callee expression.
 * @returns the receiver and method, or undefined for an ordinary call.
 */
function capabilityCall(context, callee) {
  const node = unwrap(callee)
  if (ts.isPropertyAccessExpression(node)) return capabilityFromRoot(context, node.expression, node.name.text)
  if (ts.isElementAccessExpression(node)) {
    const method = literalKey(node.argumentExpression)
    return method === undefined ? undefined : capabilityFromRoot(context, node.expression, method)
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Reflect'
    && node.expression.name.text === 'get' && node.arguments.length >= 2) {
    const method = literalKey(node.arguments[1])
    return method === undefined ? undefined : capabilityFromRoot(context, node.arguments[0], method)
  }
  return undefined
}

/**
 * Whether one receiver/method pair takes a capability from the root.
 *
 * `set` is a capability only through the reflection layer (`root.reflect.set`),
 * which overwrites a provided service; `ctx.set` and `root.tools.set` are
 * ordinary service calls and stay legal.
 * @param context - the analysis context.
 * @param receiver - the expression the method is read from.
 * @param method - the method name.
 * @returns a hit descriptor, or undefined when this is not a root capability.
 */
function capabilityFromRoot(context, receiver, method) {
  if (CAPABILITIES.has(method)) return fromRoot(context, receiver) ? { receiver, method } : undefined
  if (method !== 'set') return undefined
  const target = unwrap(receiver)
  if (!ts.isPropertyAccessExpression(target) || target.name.text !== 'reflect') return undefined
  return fromRoot(context, target.expression) ? { receiver, method } : undefined
}

/**
 * Every non-declaration source file under `src/`, read through the project's own
 * compiler options so the scan sees what `tsc` sees.
 * @returns the sources, in path order.
 */
export function sourceFiles() {
  const configPath = path.join(PACKAGE_ROOT, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, ' '))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, PACKAGE_ROOT)
  if (parsed.errors.length) throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, ' ')).join('; '))
  const options = { ...parsed.options, noEmit: true }
  // Parents are required here (a binding is resolved from the use site outwards)
  // and the compiler host leaves them unset unless asked.
  const program = ts.createProgram(parsed.fileNames, options, ts.createCompilerHost(options, true))
  const sourceRoot = path.join(PACKAGE_ROOT, 'src') + path.sep
  const files = []
  for (const sourceFile of program.getSourceFiles()) {
    const file = path.resolve(sourceFile.fileName)
    if (sourceFile.isDeclarationFile || !file.startsWith(sourceRoot)) continue
    files.push({ sourceFile, relative: path.relative(PACKAGE_ROOT, file).replaceAll('\\', '/') })
  }
  return files.sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0))
}

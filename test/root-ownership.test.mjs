/**
 * Composition-root ownership: the plugin may READ the root, never use it as the
 * receiver of a capability (event subscription, effect, inject, plugin).
 *
 * The guard in this suite reproduces dsh-tui 0.19.0's refusal word for word
 * (`dsh-tui: root.events.on is unavailable from a plugin activation`), so any
 * implementation that reaches for the root again fails here with the message a
 * user would see, not with a generic assertion.
 *
 * RED / GREEN, by hand (a bare `git checkout -- <file>` restores HEAD, which is
 * already fixed and would report a false green — always restore from a pinned
 * commit):
 *   1. `git show 5057124:src/publication/result-admission.ts > src/publication/result-admission.ts`
 *   2. `node scripts/build.mjs` (the suites import `lib/`, so an unbuilt revert is invisible)
 *   3. `node test/run.mjs root-ownership` — AC-1 fails with the dsh-tui message,
 *      and AC-3 already fails from step 1 because it scans `src/`
 *   4. `git show HEAD:src/publication/result-admission.ts > src/publication/result-admission.ts`,
 *      `node scripts/build.mjs`, `node test/run.mjs root-ownership` — all green again.
 *
 * AC-3 is a receiver analysis, not a text grep. The compiler is already a
 * devDependency, so the analyser parses the whole `src/` tree with
 * `ts.createProgram` and resolves every capability call's receiver along its
 * aliases. Its negative fixtures are source strings parsed with
 * `ts.createSourceFile`, so proving the bypass spellings are caught writes no
 * file either.
 *
 * No temporary directory is created: every check runs against an in-memory host,
 * so the suite answers on a machine where subprocess fixtures cannot.
 *
 * @module dsh-ops/test/root-ownership
 */

import path from 'node:path'
import ts from 'typescript'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { assert, report, test, PACKAGE_ROOT } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { NativeFileTools } from '../lib/projections/native/runtime.js'
import { acquireResultAdmission } from '../lib/publication/result-admission.js'
import { publicationRegistration, publicationReady } from '../lib/publication/reentry.js'
import { nativeProviderReady, registerNativeProviderAtScope } from '../lib/publication/providers.js'

const REFUSAL = 'session append cannot reenter while another append is being published'
const refusal = () => new Error(REFUSAL)
const QUEUE_EFFECT = 'dsh-ops: registry refusal queue'
const SUBSCRIPTIONS = new Set(['on', 'once', 'register', 'unregister'])

/** Race one waiting publication against a deadline so a stalled queue fails instead of hanging the gate. */
function settleWithin(promise, ms, what) {
  let timer
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(what + ' did not settle within ' + ms + ' ms')), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** One capability refusal carrying the exact shipped wording. */
function refuse(capability, touched) {
  return () => {
    touched.push(capability)
    throw new Error('dsh-tui: ' + capability + ' is unavailable from a plugin activation')
  }
}

/**
 * Substitute the composition root's capabilities with the dsh-tui refusal.
 *
 * Only the root is refused: child contexts keep their own events service and
 * fiber, exactly as the host guard leaves them. Everything else on the root
 * stays readable, because reading `root` (a WeakMap key, a logger, a service) is
 * allowed and the fix must not be mistaken for "do not touch root at all".
 * The reflection layer is refused the same way: `root.reflect.set` overwrites
 * a provided service, which is exactly the host capability a plugin must not
 * take from the root.
 * @param root - the real composition root context.
 * @param touched - collects the capability names that were actually attempted.
 * @returns a proxy of the root whose capabilities throw instead of running.
 */
function guardedCompositionRoot(root, touched) {
  const forward = (object, property) => {
    const value = Reflect.get(object, property, object)
    return typeof value === 'function' ? value.bind(object) : value
  }
  const events = new Proxy(root.events, {
    get(object, property) {
      if (typeof property === 'string' && SUBSCRIPTIONS.has(property)) return refuse('root.events.' + property, touched)
      return forward(object, property)
    },
  })
  const fiber = new Proxy(root.fiber, {
    get(object, property) {
      if (property === 'effect') return refuse('root.effect', touched)
      return forward(object, property)
    },
  })
  const reflect = new Proxy(root.reflect, {
    get(object, property) {
      if (property === 'set') return refuse('root.reflect.set', touched)
      return forward(object, property)
    },
  })
  return new Proxy(root, {
    get(object, property) {
      if (property === 'events') return events
      if (property === 'fiber') return fiber
      if (property === 'reflect') return reflect
      if (typeof property === 'string' && SUBSCRIPTIONS.has(property)) return refuse('root.events.' + property, touched)
      if (property === 'effect') return refuse('root.effect', touched)
      if (property === 'inject' || property === 'plugin') return refuse('root.' + property, touched)
      return forward(object, property)
    },
  })
}

/** Capability methods whose receiver must never be the composition root. */
const CAPABILITIES = new Set(['on', 'once', 'register', 'unregister', 'effect', 'inject', 'plugin'])

/**
 * Receiver analysis, not a text grep.
 *
 * A capability call is a hit when its receiver resolves to the composition root:
 * the root expression itself (`ctx.root`, `ctx.root.fiber`, `ctx.root.reflect`),
 * a local bound to it (`const root = ctx.root ?? ctx`, `const { root } = ctx`,
 * `const [root] = [ctx]`, `const target = root`, `let r; r = ctx.root`), or a
 * parameter a call site fills with one (a named helper, or an inline function
 * called on the spot). A root value that is only an argument — a WeakMap key,
 * `ctx.get`, a call-budget owner — never has this receiver shape, which is what
 * keeps those reads legal.
 *
 * The compiler does the reading because the spellings that reach the root are
 * unbounded: a parenthesized `??`, an optional chain, a bracket key, an object
 * or array destructuring pattern, an `as` cast, an alias hop, a comma spelling
 * and a helper parameter are all one receiver once the syntax tree says so. The
 * text regex this replaced caught one of the spellings the fixtures in AC-3 pin.
 *
 * @param sourceFile - a file from the program, or a fixture parsed on its own.
 * @returns capability calls whose receiver is the composition root.
 */
function rootReceivers(sourceFile) {
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
function hitsFor(text) {
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
 * The position an array-destructuring binding reads, when it destructures a
 * declaration's own initializer.
 *
 * `const [r] = ...` binds element 0 and `const [, r] = ...` element 1, so the
 * index is part of what the name means. A pattern on a parameter has no
 * initializer to index here and stays on the parameter path.
 * @param node - a binding element.
 * @returns the declaration's initializer and the element index, or undefined.
 */
function arrayPosition(node) {
  const pattern = node.parent
  if (!ts.isArrayBindingPattern(pattern)) return undefined
  const declaration = pattern.parent
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined
  return { container: declaration.initializer, index: pattern.elements.indexOf(node) }
}

/**
 * Every local binding in one file, by the identifier the code refers to them by.
 *
 * A destructured binding remembers the key it came from, so `const { root } = ctx`
 * and `const { root: alias } = ctx` both read as "this name is the root"; an array
 * pattern records the position instead (`const [r] = [ctx.root]`). A name
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
      const binding = { scope: bindingScope(node), pos: node.getStart(sourceFile) }
      const position = arrayPosition(node)
      if (position) {
        // `const [r] = [ctx.root]` binds by position, not by key: the value is the
        // element of the initializer at that index.
        binding.position = position
      } else {
        // `const { root } = ctx` names the key with an identifier; a computed key
        // (`const { [name]: bound } = ctx`) is not a name this analysis can read.
        const written = node.propertyName ?? node.name
        binding.key = ts.isIdentifier(written) ? written.text : literalKey(written)
      }
      add(node.name.text, binding)
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
 * stay derived on either side, because both branches denote the same receiver;
 * a comma expression takes its right operand.
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
    if (binding.position !== undefined) {
      // A destructured element is the element of the initializer: a literal array
      // answers by position, and any other initializer is a value not seen here.
      const container = unwrap(binding.position.container)
      if (!ts.isArrayLiteralExpression(container)) return false
      const element = container.elements[binding.position.index]
      return element !== undefined && fromRoot(context, element, seen)
    }
    if (binding.key !== undefined) return binding.key === 'root'
    if (binding.parameter !== undefined && context.rootParameters.has(binding.parameter)) return true
    return binding.initializer !== undefined && fromRoot(context, binding.initializer, seen)
  }
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === 'root' || fromRoot(context, expression.expression, seen)
  if (ts.isElementAccessExpression(expression)) return literalKey(expression.argumentExpression) === 'root' || fromRoot(context, expression.expression, seen)
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind
    if (operator === ts.SyntaxKind.CommaToken) return fromRoot(context, expression.right, seen)
    if (operator !== ts.SyntaxKind.QuestionQuestionToken && operator !== ts.SyntaxKind.BarBarToken
      && operator !== ts.SyntaxKind.AmpersandAmpersandToken) return false
    return fromRoot(context, expression.left, new Set(seen)) || fromRoot(context, expression.right, new Set(seen))
  }
  if (ts.isConditionalExpression(expression)) {
    return fromRoot(context, expression.whenTrue, new Set(seen)) || fromRoot(context, expression.whenFalse, new Set(seen))
  }
  return false
}

/** A function expression or arrow, whose parameters a call fills argument by argument. */
function isInlineFunction(node) {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node)
}

/**
 * Learn which helper parameters receive the root.
 *
 * A helper that subscribes for its caller (`function subscribe(target) { target.on(...) }`)
 * hides the receiver behind a parameter, so the call sites decide. An inline
 * function invoked on the spot (`(function (r) { r.on(...) })(ctx.root)`) is
 * filled by that one call, so its parameters are seeded the same way. The loop
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
      && isInlineFunction(node.initializer)) remember(node.name.text, node.initializer)
    else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)
      && isInlineFunction(node.initializer)) remember(node.name.text, node.initializer)
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
      : isInlineFunction(callee) ? [callee]
      : undefined
    if (!targets) continue
    for (const target of targets) {
      const shared = Math.min(call.arguments.length, target.parameters.length)
      for (let index = 0; index < shared; index += 1) {
        const parameter = target.parameters[index]
        // A rest parameter collects the arguments into an array, so it holds the
        // root the way `[ctx.root]` does — not the root itself.
        if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken || context.rootParameters.has(parameter)) continue
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
 * resolve, so those calls are left alone (AC-3 states the limitation).
 * @param context - the analysis context.
 * @param callee - the call's callee expression.
 * @returns the receiver and method, or undefined for an ordinary call.
 */
function capabilityCall(context, callee) {
  const node = unwrap(callee)
  // `(0, x.on)(...)` is how compiled output spells a call that must not borrow a
  // receiver from the left operand; the method is the right operand's.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) return capabilityCall(context, node.right)
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
function sourceFiles() {
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

await test('AC-1: runtime evidence and result admission subscribe on the row ctx, not on the composition root', async () => {
  const { ctx: root } = await bootHost()
  const touched = []
  const guardedRoot = guardedCompositionRoot(root, touched)
  const scope = createScope(root, { id: 'root-ownership-ac1' })
  const subscriptions = []
  const row = scope.ctx.extend({
    root: guardedRoot,
    on: (...args) => { subscriptions.push(String(args[0])); return scope.ctx.on(...args) },
  })
  try {
    assert.equal(row.root, guardedRoot, 'the fixture must present the guarded root through ctx.root')
    let runtime
    try {
      runtime = new NativeFileTools({ ctx: row, config: {} })
    } catch (error) {
      assert.fail('NativeFileTools must construct on a row ctx behind a guarded root: ' + error.message)
    }
    assert.equal(runtime.events, row, 'the runtime must keep the constructing ctx as its subscription receiver')
    let admission
    try {
      admission = acquireResultAdmission(row)
    } catch (error) {
      assert.fail('acquireResultAdmission must not reach for the composition root: ' + error.message)
    }
    assert.equal(typeof admission.authorize, 'function')
    admission.dispose()
    await runtime.stop()

    const names = [...new Set(subscriptions)]
    for (const name of ['tools/result', 'llm/stream', 'session/event', 'agent/disposed', 'session/disposed', 'system-prompt/change', 'tools/execute']) {
      assert.ok(names.includes(name), 'the row ctx must receive the ' + name + ' subscription; saw ' + JSON.stringify(names))
    }
    assert.deepEqual(touched, [], 'no capability may be taken from the composition root')
  } finally {
    await scope.dispose()
    await shutdown(root)
  }
})

await test('AC-2: a first-time queue and a native provider registration own their effects on the row ctx', async () => {
  const { ctx: root } = await bootHost()
  const touched = []
  const guardedRoot = guardedCompositionRoot(root, touched)
  const scope = createScope(root, { id: 'root-ownership-ac2' })
  const row = scope.ctx.extend({ root: guardedRoot })
  const applied = []
  const withdrawn = []
  const mounted = []
  try {
    // No queue exists for this root yet: this is the first publication and the
    // one that has to take its release effect from the row ctx.
    let dispose
    try {
      dispose = publicationRegistration(row, () => {
        applied.push('notification')
        return () => { withdrawn.push('notification') }
      })
    } catch (error) {
      assert.fail('a first publication on a guarded root must not take root.effect: ' + error.message)
    }
    await settleWithin(publicationReady(dispose), 4000, 'the first publication')
    assert.deepEqual(applied, ['notification'], 'the queued registration must actually run')
    dispose()
    assert.deepEqual(withdrawn, ['notification'])

    const definition = {
      name: 'root-ownership-fixture',
      description: 'a provider definition owned by the row ctx',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({}),
    }
    let stop
    try {
      stop = registerNativeProviderAtScope(row, scopeOf(scope.ctx), [definition], (tool) => {
        mounted.push(tool.name)
        return () => { withdrawn.push(tool.name) }
      })
    } catch (error) {
      assert.fail('provider registration must not take root.effect: ' + error.message)
    }
    assert.deepEqual(mounted, ['root-ownership-fixture'], 'the registration must actually happen')
    await settleWithin(nativeProviderReady(stop), 4000, 'the provider notification')
    stop()
    assert.ok(withdrawn.includes('root-ownership-fixture'), 'the returned teardown must withdraw the registration')
    assert.deepEqual(touched, [], 'no capability may be taken from the composition root')
  } finally {
    await scope.dispose()
    await shutdown(root)
  }
})

await test('AC-3: receiver analysis finds zero root-owned capabilities in src/', async () => {
  const files = sourceFiles()
  assert.ok(files.length > 100, 'the scan must cover the real source tree, not an empty glob: ' + files.length + ' files')
  const hits = []
  for (const { sourceFile, relative } of files) {
    for (const hit of rootReceivers(sourceFile)) hits.push(relative + ':' + hit.line + ' ' + hit.receiver + '.' + hit.method + '()')
  }
  assert.deepEqual(hits, [], 'the composition root must never be a capability receiver:\n       ' + hits.join('\n       '))
})

await test('AC-3b: the analyser catches every spelling of a root receiver, and leaves the legal reads alone', async () => {
  // Every spelling the review used to break the old text regex, each parsed on
  // its own, plus the ones later attack surfaces found (the deferred assignment,
  // array destructuring, an inline function's parameter, the comma operator). A
  // receiver analysis that misses any one of them is the same promise-without-a-
  // proof this check exists to replace, so the list is a gate, not a sample: the
  // assertion names the spelling that escaped.
  const bypasses = {
    'historical baseline (ctx.root.on)': 'ctx.root.on("tools/change", () => {})',
    'parenthesized receiver ((ctx.root ?? ctx).on)': '(ctx.root ?? ctx).on("tools/change", () => {})',
    'optional chain (ctx.root?.on)': 'ctx.root?.on("tools/change", () => {})',
    'bracket property (ctx["root"].on)': 'ctx["root"].on("tools/change", () => {})',
    'destructured root (const { root } = ctx)': 'const { root } = ctx\nroot.on("tools/change", () => {})',
    'as-cast alias (const r = ctx.root as Context)': 'const r = ctx.root as Context\nr.on("tools/change", () => {})',
    'non-null assertion (ctx.root!.on)': 'ctx.root!.on("tools/change", () => {})',
    'second alias hop (const b = a)': 'const a = ctx.root ?? ctx\nconst b = a\nb.on("tools/change", () => {})',
    'deferred assignment (let r; r = ctx.root)': 'let r\nr = ctx.root\nr.on("tools/change", () => {})',
    'deferred assignment of a parenthesized root (let r; r = (ctx.root ?? ctx))': 'let r\nr = (ctx.root ?? ctx)\nr.on("tools/change", () => {})',
    'helper parameter (target.on)': 'function subscribe(target: Context) { target.on("tools/change", () => {}) }\nsubscribe(ctx.root ?? ctx)',
    'Reflect.get (Reflect.get(ctx.root, "on"))': 'Reflect.get(ctx.root, "on")("tools/change", () => {})',
    'bracket method (ctx.root["on"])': 'ctx.root["on"]("tools/change", () => {})',
    'carrier hop (ctx.root.events.on)': 'ctx.root.events.on("tools/change", () => {})',
    'carrier hop (ctx.root.fiber.effect)': 'ctx.root.fiber.effect(() => () => {})',
    'reflect.set (ctx.root.reflect.set)': 'ctx.root.reflect.set("tools", service)',
    'reflect.set through the root alias': 'const root = ctx.root ?? ctx\nroot.reflect.set("tools", service)',
    'inject/plugin on the root': 'ctx.root.inject(["tools"])\nctx.root.plugin(plugin)',
    'array destructuring (const [r] = [ctx.root])': 'const [r] = [ctx.root]\nr.on("tools/change", () => {})',
    'array destructuring past a hole (const [, r] = [ctx, ctx.root])': 'const [, r] = [ctx, ctx.root]\nr.on("tools/change", () => {})',
    'inline function argument ((function (r) {})(ctx.root))': '(function (r) { r.on("tools/change", () => {}) })(ctx.root)',
    'comma operator callee ((0, ctx.root.on))': '(0, ctx.root.on)("tools/change", () => {})',
    'comma operator receiver ((0, ctx.root).on)': '(0, ctx.root).on("tools/change", () => {})',
  }
  for (const [name, snippet] of Object.entries(bypasses)) {
    assert.ok(hitsFor(snippet).length > 0, 'the analyser must catch ' + name + ', but it reported no receiver')
  }
  for (const capability of CAPABILITIES) {
    assert.equal(hitsFor('ctx.root.' + capability + '(argument)').length, 1, 'ctx.root.' + capability + ' is a capability call')
  }

  // The legal shapes, each named: the analysis must not answer "root used as a
  // receiver" for a root that is only a key, a service read, an owner key, or one
  // element of a value that the receiver is not.
  const legal = {
    'owners.get(key)': 'const key = ctx.root ?? ctx\nowners.get(key)',
    'roots.get(ctx.root ?? ctx)': 'const state = roots.get(ctx.root ?? ctx)',
    'withCallBudget(ctx.root ?? ctx, ...)': 'withCallBudget(ctx.root ?? ctx, String(session.id), signal, () => {})',
    'ctx.root.logger.warn': 'ctx.root.logger.warn("a property read is allowed")',
    'ctx.set (the row ctx, not the root)': 'ctx.set("tools", service)',
    'ctx.root.get (a service read)': 'const tools = ctx.root.get("tools")',
    'root.tools.set (the tools service, not the root)': 'ctx.root.tools.set("name", definition)',
    'r.logger.warn, for a name assigned the root': 'let r\nr = ctx.root ?? ctx\nr.logger.warn("a property read is allowed")',
    'rest parameter ((...r) => r.on)': '((...r) => r.on("tools/change", () => {}))(ctx.root)',
    'inner shadow (the r redeclared in h is not the root)': 'const r = ctx.root\nfunction h() { const r = other\n r.on("tools/change", () => {}) }',
  }
  for (const [name, snippet] of Object.entries(legal)) {
    assert.equal(hitsFor(snippet).length, 0, name + ' is a legal root read, but the analyser called it a capability receiver')
  }

  // A later assignment does not reach back: a use sees the value the name holds
  // at that point. Without this, an analysis that indexed the last assignment of
  // a name would count both subscriptions below as root receivers.
  assert.equal(
    hitsFor('let r = ctx.root\nr.on("tools/change", () => {})\nr = ctx\nr.on("tools/second", () => {})').length,
    1,
    'the binding a use reads is the one before it, not the last assignment in the file',
  )

  // Known limits, pinned rather than pretended away. Each one is a shape the
  // analysis deliberately does not follow, and the pin is an `assert.equal(0)`:
  // the moment the analyser starts catching one, this fails and the declaration
  // has to be corrected — the limit list rots quietly otherwise. The list was
  // completed from independent attack surfaces: every shape they reported that
  // this analysis now follows moved into `bypasses` above (the deferred
  // assignment, array destructuring, an inline function's parameter, the comma
  // operator), and only the shapes still not followed are pinned here.
  const limits = {
    // The method name is a value that only exists at run time, so there is no
    // string to compare against a capability name.
    'dynamic method key (root[method])': 'function subscribe(root: Context, method: string) { root[method]("tools/change", () => {}) }',
    // The analysis follows what a name is *initialized or assigned* with, never
    // what a function returns. Giving every function a "does it return the root"
    // verdict is a call graph, and AC-1/AC-2 already catch this shape at run time.
    'helper return value (pick(ctx).on)': 'function pick(context: Context) { return context.root ?? context }\npick(ctx).on("tools/change", () => {})',
    // A container is a different value: `arr` holds the root, it is not the
    // root. Element identity would have to be indexed (`arr[0]` is the root,
    // `arr[1]` is not) and a coarse "a container that holds the root makes every
    // element the root" rule would call `const pair = { root, api }; pair.api.on(...)`
    // a hit — the false red this analysis exists to avoid.
    'array container (const arr = [ctx.root])': 'const arr = [ctx.root]\narr[0].on("tools/change", () => {})',
    'object container (const o = { r: ctx.root })': 'const o = { r: ctx.root }\no.r.on("tools/change", () => {})',
    // `this.r` is a class property, not a local: resolving it needs the class
    // symbol and `this` typing, and a field can be reassigned from any method, so
    // one initializer is not a value a use can trust.
    'class field (this.r = c.root)': 'class C { r: Context\n constructor(c: Context) { this.r = c.root }\n m() { this.r.on("tools/change", () => {}) } }',
    // `Function.prototype.call` puts the method one hop further out and the
    // receiver in the argument list; following `apply`/`bind` would mean reading
    // the prototype, which is a different analysis from "which value is this".
    'call through Function.prototype.call (r.on.call)': 'const r = ctx.root\nr.on.call(r, "tools/change", () => {})',
    // A spread rebuilds an argument list, so the call whose result is subscribed
    // to has no receiver this analysis can name.
    'spread argument (fn(...[r]).on)': 'const r = ctx.root\nfn(...[r]).on("tools/change", () => {})',
    // A `for...of` binding is a loop variable: its value comes from the iterable
    // per iteration, which the analysis would have to simulate.
    'for-of binding (for (const r of [ctx.root]))': 'for (const r of [ctx.root]) { r.on("tools/change", () => {}) }',
    // A catch clause binds whatever the try block threw. Reading that value is a
    // control-flow fact — any statement in the block, or any callee it calls, can
    // throw — and "every catch parameter is the root" would be a predicate
    // widened until an ordinary error handler reads as a hit.
    'catch binding (try { throw ctx.root } catch (e))': 'try { throw ctx.root } catch (e) { e.on("tools/change", () => {}) }',
    // A pattern position reads what the declaration's initializer holds there; a
    // default value is taken only when that position is `undefined` at run time,
    // which is a fact no local value decides — so neither the object nor the
    // array pattern follows `= ctx.root`.
    'destructuring default (const [r = ctx.root] = [])': 'const { target = ctx.root } = plugins\nconst [r = ctx.root] = []\ntarget.on("tools/change", () => {})\nr.on("tools/change", () => {})',
    // A destructured parameter is filled by its call site, and taking the element
    // the argument holds is a second step: the position would have to be carried
    // from the parameter pattern through the call's argument to a literal array.
    'destructured parameter (function sub([r]) { r.on(...) })': 'function sub([r]) { r.on("tools/change", () => {}) }\nsub([ctx.root])',
    // A callback parameter is filled by the method it is passed to, not by the
    // call site this file can read: `[ctx.root].forEach((r) => r.on(...))` needs
    // both the element identity of the receiver and the callback contract of
    // `forEach`. Treating every callback parameter as "whatever is around it"
    // would make `list.map((item) => item.on(...))` a hit on any list near the root.
    'callback element ([ctx.root].forEach((r) => r.on(...)))': '[ctx.root].forEach((r) => r.on("tools/change", () => {}))',
  }
  for (const [name, snippet] of Object.entries(limits)) {
    assert.equal(hitsFor(snippet).length, 0, 'the analyser is documented not to resolve ' + name + '; it now does, so update the limit list')
  }
})

await test('AC-3c: the guard fixture refuses root.reflect.set, so the runtime face matches the scan', async () => {
  const { ctx: root } = await bootHost()
  const touched = []
  const guardedRoot = guardedCompositionRoot(root, touched)
  try {
    // The reflection layer overwrites a provided service; a host that locks it
    // refuses a plugin exactly like it refuses root.events.on. Without this
    // assertion the proxy branch would be untested fixture code.
    assert.throws(
      () => guardedRoot.reflect.set('tools', {}),
      (error) => error.message === 'dsh-tui: root.reflect.set is unavailable from a plugin activation',
      'root.reflect.set must be refused with the shipped wording',
    )
    assert.deepEqual(touched, ['root.reflect.set'], 'the refusal must be the one that was attempted')
    // Reading the reflection layer is not a capability: only \`set\` writes.
    assert.equal(typeof guardedRoot.reflect.get, 'function', 'a read through root.reflect stays allowed')
    assert.equal(typeof guardedRoot.reflect.provide, 'function', 'the rest of root.reflect stays readable')
  } finally {
    await shutdown(root)
  }
})

await test('AC-4: two rows on one root share a refusal window, and one row unloading does not interrupt the other', async () => {
  const { ctx: root } = await bootHost()
  const scopeA = createScope(root, { id: 'root-ownership-ac4-a' })
  const scopeB = createScope(root, { id: 'root-ownership-ac4-b' })
  let locked = true
  let attemptsA = 0
  let attemptsB = 0
  const applied = []
  try {
    assert.equal(scopeA.ctx.root, root, 'row A must sit on the checked root')
    assert.equal(scopeB.ctx.root, root, 'row B must sit on the same root')
    const disposeA = publicationRegistration(scopeA.ctx, () => {
      ++attemptsA
      if (locked) throw refusal()
      applied.push('A')
      return () => {}
    })
    const disposeB = publicationRegistration(scopeB.ctx, () => {
      ++attemptsB
      if (locked) throw refusal()
      applied.push('B')
      return () => {}
    })
    assert.equal(attemptsA, 1, 'the first registration takes the refusal window synchronously')
    assert.equal(attemptsB, 0, 'a second row must wait in the same window; a per-row queue would try immediately')
    const cancellation = publicationReady(disposeA).catch((error) => error)
    const survivor = publicationReady(disposeB)
    await scopeA.dispose()
    const cancelled = await cancellation
    assert.match(String(cancelled?.message ?? cancelled), /cancelled/, 'row A\'s own pending work is cancelled by its unload')
    locked = false
    const settlement = await settleWithin(survivor, 4000, 'row B publication after row A unloaded').then(() => undefined, (error) => error)
    assert.equal(settlement, undefined, 'row B must settle after row A unloads instead of reading "Publication root disposed": ' + settlement)
    assert.ok(applied.includes('B'), 'row B\'s registration must run')

    disposeB()
    await scopeB.dispose()
    // Every owner is gone: the queue must be disposed and rebuilt for the next
    // row, not left stopped (a stopped queue silently swallows submissions).
    const later = createScope(root, { id: 'root-ownership-ac4-later' })
    const laterApplied = []
    const disposeLater = publicationRegistration(later.ctx, () => {
      laterApplied.push('later')
      return () => {}
    })
    await settleWithin(publicationReady(disposeLater), 2000, 'a row registered after every prior owner unloaded')
    assert.deepEqual(laterApplied, ['later'])
    disposeLater()
    await later.dispose()
  } finally {
    await scopeA.dispose().catch(() => {})
    await scopeB.dispose().catch(() => {})
    await shutdown(root)
  }
})

await test('AC-4b: references count owner fibers, so two extended contexts share one reference and one release', async () => {
  const { ctx: root } = await bootHost()
  const rowScope = createScope(root, { id: 'root-ownership-ac4b-row' })
  const siblingScope = createScope(root, { id: 'root-ownership-ac4b-sibling' })
  const row = rowScope.ctx
  const first = row.extend({})
  const second = row.extend({})
  assert.notEqual(first, second, 'extend must produce distinct context objects')
  assert.equal(first.fiber, second.fiber, 'both extended contexts must share the row fiber')
  assert.equal(first.root, root, 'both extended contexts still read the shared root')

  const labels = []
  const original = row.fiber.effect
  row.fiber.effect = function (execute, label) {
    labels.push(label ?? 'anonymous')
    return original.call(row.fiber, execute, label)
  }
  try {
    const applied = []
    const disposeFirst = publicationRegistration(first, () => { applied.push('first'); return () => {} })
    const disposeSecond = publicationRegistration(second, () => { applied.push('second'); return () => {} })
    await settleWithin(Promise.all([publicationReady(disposeFirst), publicationReady(disposeSecond)]), 4000, 'both extended registrations')
    assert.deepEqual(applied.sort(), ['first', 'second'], 'both registrations must run, so both really retained the queue')
    const retained = labels.filter((label) => label === QUEUE_EFFECT)
    assert.equal(retained.length, 1, 'one fiber owns one reference; two extended contexts registered ' + retained.length + ' queue effects')
    const leases = labels.filter((label) => label === 'dsh-ops: registry publication lease')
    assert.equal(leases.length, 2, 'each registration still has its own lease')

    // A sibling row keeps the queue alive: the row fiber unload must release
    // exactly the one reference it took, never two.
    let locked = true
    let attempts = 0
    let appliedSibling = false
    const disposeSibling = publicationRegistration(siblingScope.ctx, () => {
      ++attempts
      if (locked) throw refusal()
      appliedSibling = true
      return () => {}
    })
    const cancelledFirst = publicationReady(disposeFirst).catch(() => undefined)
    const cancelledSecond = publicationReady(disposeSecond).catch(() => undefined)
    await rowScope.dispose()
    await cancelledFirst
    await cancelledSecond
    locked = false
    const surviving = await settleWithin(publicationReady(disposeSibling), 4000, 'the sibling row after the extended fiber unloaded')
      .then(() => undefined, (error) => error)
    assert.equal(surviving, undefined, 'the sibling row must settle; an over-released reference reads "Publication root disposed": ' + surviving)
    assert.ok(appliedSibling, 'the sibling registration must run')
    assert.ok(attempts >= 2, 'the sibling really retried after its refusal: ' + attempts + ' attempt(s)')

    disposeSibling()
    await siblingScope.dispose()
    const later = createScope(root, { id: 'root-ownership-ac4b-later' })
    const laterApplied = []
    const disposeLater = publicationRegistration(later.ctx, () => { laterApplied.push('later'); return () => {} })
    await settleWithin(publicationReady(disposeLater), 2000, 'a row registered after the last owner unloaded')
    assert.deepEqual(laterApplied, ['later'])
    disposeLater()
    await later.dispose()
  } finally {
    row.fiber.effect = original
    await rowScope.dispose().catch(() => {})
    await siblingScope.dispose().catch(() => {})
    await shutdown(root)
  }
})

report('root-ownership')

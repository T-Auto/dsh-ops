// Tests real installed dsh-ops contracts and the real host registry, without
// modifying either package. Explicit roots are required; missing packages fail.
// node scripts/host-compat-smoke.mjs --ops-root PATH --host-root PATH
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createHostTools, registerHostTools, toHostOutcome, HOST_OUTCOME_SCHEMA, opsPtcAddition } = require('../dist/ptc/tools.js');
function option(name) {
  const at = process.argv.indexOf(name);
  assert(at !== -1 && process.argv[at + 1], `Required: ${name} PATH`);
  return path.resolve(process.argv[at + 1]);
}
const opsRoot = option('--ops-root');
const hostRoot = option('--host-root');
// Compile an in-memory consumer against real published host declaration files.
const ts = require('typescript');
const virtualFile = path.resolve('scripts/.host-contract-check.mts');
const hostTypes = path.join(hostRoot, '@deepseek-ai/dsh-tools/lib/types/index.js').replaceAll('\\', '/');
const source = `import type { ToolDefinition, ToolRuntime } from ${JSON.stringify(hostTypes)};
import { registerHostTools, type HostToolDefinition, type HostBridge } from '../src/ptc/adapter.js';
import type { PtcToolAddition } from '../src/ptc/tools.js';
const definition: ToolDefinition = null as unknown as HostToolDefinition;
registerHostTools({tools: null as unknown as ToolRuntime}, null as unknown as PtcToolAddition, null as unknown as HostBridge);
void definition;`;
const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, esModuleInterop: true, noEmit: true };
const compilerHost = ts.createCompilerHost(options);
const getSourceFile = compilerHost.getSourceFile.bind(compilerHost);
compilerHost.getSourceFile = (file, language, onError, create) => path.resolve(file) === virtualFile ? ts.createSourceFile(file, source, language, true) : getSourceFile(file, language, onError, create);
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([virtualFile], options, compilerHost));
assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {getCanonicalFileName: x => x, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n'}));
const load = (root, file) => import(pathToFileURL(path.join(root, file)).href);
const [{ outcomeSchema }, contract, host, { Context }] = await Promise.all([
  load(opsRoot, 'lib/modes/ptc/schema.js'), load(opsRoot, 'lib/ptc/contract.js'),
  load(hostRoot, '@deepseek-ai/dsh-tools/lib/index.js'), load(hostRoot, '@deepseek-ai/cordis/lib/index.js'),
]);
let assertions = 0;
const check = (value, message) => { assertions++; assert(value, message); };
const canonical = outcomeSchema({ type: 'object', properties: {}, additionalProperties: true });
host.assertSupportedJsonSchema(canonical);
host.assertSupportedJsonSchema(HOST_OUTCOME_SCHEMA);
const validate = value => {
  for (const schema of [canonical, HOST_OUTCOME_SCHEMA]) {
    const errors = host.validateJsonSchemaValue(schema, value);
    check(errors.length === 0, JSON.stringify({ value, errors }));
  }
  return value;
};
const exec = { agent: { session: { id: 'host-compat-smoke' } } };
let invocations = 0;
const bridge = { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) },
  invoke: async () => { invocations++; return { status: 'ok', file: 'fixture.ts' }; } };
const tools = createHostTools(opsPtcAddition, bridge);
check(tools.length === 5, 'Five definitions must be exposed');
for (const tool of tools) {
  check(typeof tool.execute === 'function' && tool.parameters && tool.output.schema && tool.timeoutMs > 0, 'Real definition shape');
  check(tool.output.render({}, { status: 'completed', data: {} })[0].type === 'text', 'Renderer contract');
}
const locate = tools.find(t => t.name === 'ops_ptc_locate');
const rewrite = tools.find(t => t.name === 'ops_ptc_inproc');
check(validate(await locate.execute({ symbol: 'f' }, exec)).status === 'completed', 'Successful bridge');
const count = invocations;
check(validate(await locate.execute({}, {})).error.code === 'EXECUTOR_UNAVAILABLE', 'Missing session fails closed');
const noBridge = createHostTools(opsPtcAddition, { sandboxPolicy: bridge.sandboxPolicy })[0];
check(validate(await noBridge.execute({}, exec)).error.code === 'EXECUTOR_UNAVAILABLE', 'Missing bridge fails closed');
const noPolicy = createHostTools(opsPtcAddition, { invoke: bridge.invoke })[0];
check(validate(await noPolicy.execute({}, exec)).error.code === 'EXECUTOR_UNAVAILABLE', 'Missing policy service fails closed');
const invalidPolicy = createHostTools(opsPtcAddition, { ...bridge, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'relative' }) } })[0];
check(validate(await invalidPolicy.execute({}, exec)).error.code === 'EXECUTOR_UNAVAILABLE', 'Relative root fails closed');
const readOnly = createHostTools(opsPtcAddition, { ...bridge, sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: process.cwd() }) } });
check(validate(await readOnly.find(t => t.name === rewrite.name).execute({}, exec)).error.code === 'POLICY_DENIED', 'Default apply rejected in read-only');
check(validate(await readOnly.find(t => t.name === 'ops_ptc_audit').execute({}, exec)).error.code === 'POLICY_DENIED', 'Scratch audit requires write');
const controller = new AbortController(); controller.abort();
check(validate(await locate.execute({}, { ...exec, signal: controller.signal })).error.code === 'ABORTED', 'Cancellation before bridge');
check(invocations === count, 'Rejected calls never invoke bridge');
const thrown = createHostTools(opsPtcAddition, { ...bridge, invoke: async () => { throw new Error('unsettled'); } })[0];
check(validate(await thrown.execute({}, exec)).error.effectState === 'unknown', 'Possible writes retain uncertainty');
for (const value of [undefined, { status: 'unrecognized' }, { status: 'error', code: 'TEST', message: 'failed' },
  { status: 'ok', locate: { truncated: true } }, { status: 'ok', locate: { pruned: 3 } }]) validate(toHostOutcome(value));
check(toHostOutcome({ status: 'ok', locate: { truncated: true } }).error.code === 'RESULT_PARTIAL', 'No fabricated continuation');
const unsettled = toHostOutcome({ status: 'error', code: 'E_WRITE', message: 'partial commit', committed: ['fixture.ts'] }, true);
validate(unsettled);
check(unsettled.error.effectState === 'unknown' && unsettled.data.committed[0] === 'fixture.ts', 'Write failure retains postcondition evidence');
const partial = validate(toHostOutcome({ status: 'partial', data: { rows: [] }, coverage: { scannedFiles: 2, matchedCount: 1, isComplete: false }, continuation: 'opaque-trusted-cursor' }));
check(partial.status === 'partial', 'Real cursor retained');
for (const status of ['rejected', 'conflict', 'error', 'unknown']) {
  const out = validate(toHostOutcome({ status, error: { code: 'TEST', message: 'settled', effectState: 'none', retry: 'never' } }));
  check(out.status === status, 'Canonical failure status preserved');
}
// Invoke the installed original contract, not a copied stand-in. Its flat-result
// mismatch is the regression motivating the separate adapter envelope.
const original = contract.definition(contract.PTC_TOOLS[0], async () => ({ status: 'ok' }));
check((await original.execute({}, exec)).status === 'unknown', 'Original contract rejects legacy flat receipts');
const originalPartial = contract.definition(contract.PTC_TOOLS[0], async () => partial);
check((await originalPartial.execute({}, exec)).error.code === 'RESULT_PARTIAL', 'Original worker normalizer is not an adapter-envelope passthrough');
// Real ToolRuntime registration/disposal; systemPrompt is the only ancillary
// service stub. No synthetic replacement for register/get/schema validation.
const ctx = new Context();
ctx.provide('systemPrompt', { tools: () => () => {} });
const registry = new host.ToolRuntime(ctx);
const dispose = registerHostTools({ tools: registry }, opsPtcAddition, bridge);
for (const tool of tools) check(registry.get(tool.name)?.name === tool.name, `Registered ${tool.name}`);
check(validate(await registry.get(locate.name).execute({ symbol: 'f' }, exec)).status === 'completed', 'Real registered definition executes');
dispose(); dispose();
for (const tool of tools) check(registry.get(tool.name) === undefined, `Unregistered ${tool.name}`);
// Rollback after a registration error also uses the actual registry.
let registrations = 0;
assert.throws(() => registerHostTools({ tools: { register(def) {
  if (++registrations === 3) throw new Error('injected registration failure');
  return registry.register(def);
} } }, opsPtcAddition, bridge), /injected registration failure/);
for (const tool of tools) check(registry.get(tool.name) === undefined, 'Registration failure cleaned earlier definitions');
console.log(JSON.stringify({ status: 'passed', assertions, opsRoot, hostRoot, limitation: 'Definition/Outcome/registration contract tested; trusted production invoke is still host integration work, not native discovery plug-and-play.' }));

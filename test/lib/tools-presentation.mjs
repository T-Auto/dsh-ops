/**
 * Fixture adapter: presentation ergonomics across the supported DSH range.
 *
 * The rc2 line drives presentation through the tools service's `mode` config and
 * `tools.presentAs()`; DSH 0.2.2 removed both — presentation became an executor
 * mounted per scope through `tools.setExecutor()`. This module detects which
 * architecture is installed and restores the same fixture vocabulary on both:
 *
 * - rc2 line: nothing to patch — `presentAs` and the single-call `execute` shape
 *   are the service's own API.
 * - 0.2.2: `presentAs(mode)` mounts the published executor plugins (`native` →
 *   `NativeToolExecutor`, `ptc` → `PtcExecutor`, `both` → one composite presenting
 *   native schemas alongside the reserved transport), and the rc2 single-call
 *   `tools.execute({agent, callId, name, arguments, signal})` shape is translated
 *   into one `ToolBatchInput` batch.
 *
 * Install once per process; the patch lands on the shared `ToolsService` prototype.
 * @module dsh-ops/test/tools-presentation
 */

/** The reserved transport name every 0.2.2 executor treats as presentation infrastructure. */
const RUN_CODE_NAME = 'run_code'

/** One executor presenting native schemas AND the program transport (rc2 `both`). */
function bothExecutor(ctx, nativeModule, ptcModule) {
  const native = new nativeModule.NativeToolExecutor(ctx)
  const ptc = new ptcModule.PtcExecutor(ctx)
  return {
    sections: ptc.sections,
    describe(tools) {
      const nativeView = native.describe(tools)
      const ptcView = ptc.describe(tools)
      return {
        schemas: [...nativeView.schemas, ...ptcView.schemas],
        knownNames: [...(nativeView.knownNames ?? nativeView.schemas.map(schema => schema.name)), ...(ptcView.knownNames ?? [])],
      }
    },
    async execute(input) {
      const direct = { ...input, calls: input.calls.filter(call => call.name !== RUN_CODE_NAME) }
      const program = { ...input, calls: input.calls.filter(call => call.name === RUN_CODE_NAME) }
      const [nativeBatch, ptcBatch] = await Promise.all([
        direct.calls.length ? native.execute(direct) : undefined,
        program.calls.length ? ptc.execute(program) : undefined,
      ])
      const settled = new Map([...nativeBatch?.results ?? [], ...ptcBatch?.results ?? []].map(entry => [entry.callId, entry]))
      return {
        results: input.calls.map(call => settled.get(call.id)).filter(entry => entry !== undefined),
        additionalContexts: [...nativeBatch?.additionalContexts ?? [], ...ptcBatch?.additionalContexts ?? []],
        concluded: (nativeBatch ?? ptcBatch ?? { concluded: false }).concluded,
      }
    },
  }
}

/**
 * Detect the installed tools architecture and patch what the 0.2.2 line removed.
 * @param {object} toolsModule - the `@deepseek-ai/dsh-tools` module namespace.
 * @returns {Promise<boolean>} true when the 0.2.2 executor architecture is installed.
 */
export async function installPresentationCompat(toolsModule) {
  const tools = toolsModule?.ToolsService !== undefined || toolsModule?.default !== undefined ? toolsModule : { default: toolsModule }
  const prototype = tools.ToolsService?.prototype ?? tools.default?.prototype
  if (prototype === undefined) return false
  if (typeof prototype.setExecutor !== 'function') return false // rc2 line: native support.
  const [nativeModule, ptcModule] = await Promise.all([
    import('@deepseek-ai/dsh-tool-executor-native'),
    import('@deepseek-ai/dsh-tool-executor-ptc'),
  ])
  prototype.presentAs = function presentAs(mode) {
    const executor = mode === 'native' ? new nativeModule.NativeToolExecutor(this.ctx)
      : mode === 'both' ? bothExecutor(this.ctx, nativeModule, ptcModule)
        : new ptcModule.PtcExecutor(this.ctx)
    return this.setExecutor(executor)
  }
  const batchExecute = prototype.execute
  prototype.execute = function execute(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input?.calls) || typeof input?.name !== 'string') {
      return batchExecute.call(this, input)
    }
    // rc2 single-call shape: one call in, one settled result out.
    const { callId, name, arguments: args, agent, signal, toolSet } = input
    const block = { type: 'tool-call', id: callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) }
    return batchExecute.call(this, { calls: [block], signal, agent, ...(toolSet ? { toolSet } : {}) })
      .then(batch => batch.results[0]?.result ?? batch.results[0])
  }
  return true
}

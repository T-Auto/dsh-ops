/**
 * Fixture adapter: presentation ergonomics across supported and investigated DSH versions.
 *
 * The rc2 line drives presentation through the tools service's `mode` config and
 * `tools.presentAs()`; DSH 0.2.2 removed both — presentation became an executor
 * mounted per scope through `tools.setExecutor()`. This module detects which
 * architecture is installed and restores the same fixture vocabulary on both:
 *
 * - rc2 line: nothing to patch — `presentAs` and the single-call `execute` shape
 *   are the service's own API.
 * - 0.2.2: `presentAs(mode)` mounts the published executor plugins (`native` →
 *   `NativeToolExecutor`, `ptc` → `PtcExecutor`), and the rc2 single-call
 *   `tools.execute({agent, callId, name, arguments, signal})` shape is translated
 *   into one `ToolBatchInput` batch.
 *
 * Install once per process; the patch lands on the shared `ToolsService` prototype.
 * @module dsh-ops/test/tools-presentation
 */

const installed = new WeakMap()

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
  if (installed.has(prototype)) return installed.get(prototype)
  const installation = installExecutorAdapters(prototype)
  installed.set(prototype, installation)
  return installation
}

async function installExecutorAdapters(prototype) {
  const [nativeModule, ptcModule] = await Promise.all([
    import('@deepseek-ai/dsh-tool-executor-native'),
    import('@deepseek-ai/dsh-tool-executor-ptc'),
  ])
  prototype.presentAs = function presentAs(mode) {
    if (mode !== 'native' && mode !== 'ptc') throw new Error('Unsupported executor presentation: ' + mode)
    const executor = mode === 'native' ? new nativeModule.NativeToolExecutor(this.ctx)
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

/**
 * Optional dsh-ops coexistence bridge.
 *
 * The bundle patch declares the compatibility override; this module only owns the switch-off
 * override and the agent-scoped hiding of duplicate official tools. Keeping the enable path
 * declarative is what makes the feature removable with the bundle.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const isSet = (value) => typeof value === 'string' && value.length > 0
const describe = (error) => error instanceof Error ? error.message : String(error)

/** Markers for the only profile blocks this plugin may own. */
const DSH_OPS_PATCH_MARKER = '# dsh-win-pwsh7: dsh-ops compatibility (managed)'
const DSH_OPS_PATCH_BLOCK = `${DSH_OPS_PATCH_MARKER}\n- id: dsh-ops-compat\n  disabled: false\n`
const DSH_OPS_DISABLE_MARKER = '# dsh-win-pwsh7: dsh-ops compatibility disabled (managed)'
const DSH_OPS_DISABLE_BLOCK = `${DSH_OPS_DISABLE_MARKER}\n- id: dsh-ops-compat\n  disabled: true\n`

/**
 * The active profile directory. DSH exposes it to profile-launched processes; the
 * plugin-manager instance carries the same directory as a fallback for hosts that do not.
 * @param ctx - the row's Host context.
 * @returns the profile directory, or `undefined` when it cannot be established safely.
 */
function profileDirectory(ctx) {
  if (isSet(process.env.DSH_PROFILE_DIR)) return process.env.DSH_PROFILE_DIR
  const manager = ctx.get('pluginManager')
  const directory = manager?.profile?.dir
  return isSet(directory) ? directory : undefined
}

/**
 * Whether dsh-ops is installed in this profile, read through the plugin manager's public
 * bundle view. A missing manager or an unreadable view is "not detected", never an error.
 * @param ctx - the row's Host context.
 * @returns true when the dsh-ops bundle is present.
 */
async function dshOpsInstalled(ctx) {
  const manager = ctx.get('pluginManager')
  if (manager === undefined || typeof manager.listBundles !== 'function') return false
  try {
    const bundles = await manager.listBundles()
    const ops = Array.isArray(bundles)
      ? bundles.find((bundle) => bundle?.name === 'dsh-ops' && bundle.installed !== false)
      : undefined
    return ops !== undefined && Array.isArray(ops.rows) && ops.rows.some((row) => row?.moduleName === 'dsh-ops/compat')
  } catch {
    return false
  }
}

/**
 * Whether dsh-ops is layered before dsh-win-pwsh7. The bundle override can only target a row
 * inserted by an earlier layer; a reversed order would be warned and skipped by the loader.
 * @param ctx - the row's Host context.
 * @returns true when the order is usable or cannot be established.
 */
function bundleOrderOk(ctx) {
  const directory = profileDirectory(ctx)
  if (directory === undefined) return true
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) return true
    const ops = bundles.indexOf('dsh-ops')
    const pwsh7 = bundles.indexOf('dsh-win-pwsh7')
    return ops < 0 || pwsh7 < 0 || ops < pwsh7
  } catch {
    return true
  }
}

/**
 * Read and rewrite the profile patch atomically; a failed write leaves the previous file.
 * @param path - the profile patch file.
 * @param transform - receives the current text and returns the next text.
 * @returns true when the file changed.
 */
function rewriteProfilePatch(path, transform) {
  let current = ''
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    current = ''
  }
  const next = transform(current)
  if (next === current) return false
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, next, 'utf8')
  renameSync(temporary, path)
  return true
}

/**
 * Remove the marked block only; a user's own `dsh-ops-compat` override is not touched.
 * @param text - the profile patch text.
 * @returns the text without this plugin's block.
 */
function withoutCompatBlock(text) {
  return text
    .replace(/# dsh-win-pwsh7: dsh-ops compatibility \(managed\)\r?\n- id: dsh-ops-compat\r?\n  disabled: false\r?\n?/u, '')
    .replace(/# dsh-win-pwsh7: dsh-ops compatibility disabled \(managed\)\r?\n- id: dsh-ops-compat\r?\n  disabled: true\r?\n?/u, '')
}

/** Whether the user already owns a dsh-ops-compat override outside our markers. */
function hasForeignCompatEntry(text) {
  return /^\s*-\s*(?:\{\s*)?id:\s*['"]?dsh-ops-compat\b/mu.test(withoutCompatBlock(text))
}

/**
 * Ensure the bundle owns the enabled state, and the profile owns only an explicit switch-off.
 * @param ctx - the row's Host context.
 * @param config - the live row configuration.
 * @returns `{ changed, state }` for logging; never throws.
 */
export async function ensureDshOpsCompat(ctx, config) {
  const directory = profileDirectory(ctx)
  if (directory === undefined) return { changed: false, state: 'no-profile' }
  const path = join(directory, 'cordis.patch.yml')
  const installed = await dshOpsInstalled(ctx)
  const enabled = config?.dshOpsCompat !== false
  if (!installed) {
    return { changed: rewriteProfilePatch(path, (text) => withoutCompatBlock(text)), state: 'not-installed' }
  }
  if (enabled) {
    if (bundleOrderOk(ctx)) {
      // The bundle patch enables compatibility. Remove only legacy managed blocks so an old
      // profile does not keep a duplicate override; a user's own entry is untouched.
      const changed = rewriteProfilePatch(path, (text) => {
        if (!text.includes(DSH_OPS_PATCH_MARKER) && !text.includes(DSH_OPS_DISABLE_MARKER)) return text
        return withoutCompatBlock(text)
      })
      return { changed, state: 'bundle' }
    }
    // Older/foreign profiles can list pwsh7 before dsh-ops; the bundle override would be
    // skipped. Keep the legacy profile enable block as a working fallback.
    const changed = rewriteProfilePatch(path, (text) => {
      if (hasForeignCompatEntry(text)) return text
      if (text.includes(DSH_OPS_PATCH_MARKER)) return text
      const base = withoutCompatBlock(text)
      const normalized = base.trim() === '[]' ? '' : base
      const separator = normalized === '' || normalized.endsWith('\n') ? '' : '\n'
      return `${normalized}${separator}${DSH_OPS_PATCH_BLOCK}`
    })
    return { changed, state: 'legacy-order' }
  }
  const changed = rewriteProfilePatch(path, (text) => {
    // Respect a user-owned override instead of fighting it with a second id.
    if (hasForeignCompatEntry(text)) return withoutCompatBlock(text)
    if (text.includes(DSH_OPS_DISABLE_MARKER)) return text
    const base = withoutCompatBlock(text)
    const normalized = base.trim() === '[]' ? '' : base
    const separator = normalized === '' || normalized.endsWith('\n') ? '' : '\n'
    return `${normalized}${separator}${DSH_OPS_DISABLE_BLOCK}`
  })
  return { changed, state: 'disabled' }
}

/** Synchronous best-effort removal for plugin disposal and config changes. */
export function removeDshOpsCompatPatch(ctx) {
  const directory = profileDirectory(ctx)
  if (directory === undefined) return false
  try {
    return rewriteProfilePatch(join(directory, 'cordis.patch.yml'), (text) => withoutCompatBlock(text))
  } catch (error) {
    ctx.logger?.warn?.('dsh-win-pwsh7: could not remove the dsh-ops compatibility patch: %s', describe(error))
    return false
  }
}

/**
 * The tool-name facts of one agent, read from the host's pre-restriction view when it is
 * available.
 *
 * `visible` is POST-restriction: hiding read/glob/grep removes them from it, so the next
 * reconcile pass no longer saw a counterpart pair, lifted the mask, saw the pair again, and
 * restored it. Each flip emitted `tools/change`, which called this reconcile again — an
 * endless hide/unhide loop that starved the Host main thread once many agents were created.
 * `knownNames` / `restrictableNames` keep the pre-restriction facts and are also the only
 * names `tools.restrict()` accepts, so the deny list is stable and valid.
 * @param tools - the tool registry.
 * @param agent - the agent scope.
 * @param previousDeny - names this bridge already hid, used to keep older hosts stable.
 * @returns `{ names, restrictable }`, both empty when the surface cannot be read.
 */
export function toolNameFacts(tools, agent, previousDeny = []) {
  try {
    const view = tools.view?.(agent)
    const known = view?.knownNames
    if (known !== undefined && typeof known.has === 'function') {
      const restrictable = view?.restrictableNames
      const facts = {
        names: new Set(known),
        restrictable: new Set(restrictable !== undefined && typeof restrictable.has === 'function' ? restrictable : known),
      }
      for (const name of previousDeny) {
        facts.names.add(name)
        facts.restrictable.add(name)
      }
      return facts
    }
    // Older hosts expose only the visible map or the schema projection. It is
    // post-restriction, but unioning the names this bridge already hid keeps a
    // hide/unhide loop from forming in the fallback path too.
    const visible = view?.visible
    let names
    if (visible !== undefined && typeof visible.keys === 'function') {
      names = new Set(visible.keys())
    } else {
      const schemas = tools.schemas?.(agent)
      names = new Set(Array.isArray(schemas) ? schemas.map((schema) => schema.name) : [])
    }
    for (const name of previousDeny) names.add(name)
    return { names, restrictable: new Set(names) }
  } catch {
    return { names: new Set(), restrictable: new Set() }
  }
}

/**
 * The official tools this bridge re-hides when their OPS counterparts are visible. The
 * counterpart test is deliberate: without it the bridge would hide official tools on a
 * machine where dsh-ops is absent or Compatibility is off. Candidates are filtered to the
 * names the host will actually accept in `tools.restrict()`, so a scope-local name such as
 * a session-owned `ops_bash` can never make the whole mask throw.
 * @param facts - the agent's stable tool-name facts.
 * @returns the official names to deny.
 */
export function bridgeDenyNames(facts) {
  const { names } = facts
  const deny = []
  if (names.has('ops_inspect_local_file') && names.has('read')) deny.push('read')
  if (names.has('ops_glob') && names.has('glob')) deny.push('glob')
  if (names.has('ops_grep') && names.has('grep')) deny.push('grep')
  if (names.has('ops_bash')) {
    if (names.has('bash')) deny.push('bash')
    // Compatibility would otherwise expose both PowerShell tools beside ops_bash; keep
    // the ordinary `pwsh` and remove the persistent duplicate.
    if (names.has('pwsh') && names.has('pwsh_persistent')) deny.push('pwsh_persistent')
  }
  return deny.filter((name) => facts.restrictable.has(name))
}

/**
 * Keep the official file tools and duplicate shell out of the model's view when dsh-ops
 * Compatibility is on. Agent-scoped `tools.restrict` is the only seam that hides rather
 * than denies; every mask is lifted with its agent or with this effect.
 * @param ctx - the row's Host context.
 * @param current - reads the live row configuration.
 * @returns a disposer for the bridge.
 */
export function mountDshOpsBridge(ctx, current) {
  if (typeof ctx.on !== 'function') return
  const tools = ctx.tools ?? ctx.get('tools')
  const agents = ctx.get('agents')
  if (tools === undefined || agents === undefined || typeof tools.restrict !== 'function') return
  const entries = new Map()
  let stopped = false
  let mutating = false
  const lift = (entry) => {
    entry.deny = []
    for (const dispose of entry.lifts.splice(0)) {
      try {
        dispose?.()
      } catch (error) {
        ctx.logger?.warn?.('dsh-win-pwsh7: bridge restriction cleanup failed: %s', describe(error))
      }
    }
  }
  const reconcile = () => {
    if (stopped || mutating) return
    mutating = true
    try {
      const enabled = current()?.dshOpsCompat !== false
      if (!enabled) {
        for (const entry of entries.values()) lift(entry)
        entries.clear()
        return
      }
      for (const agent of agents.list?.() ?? []) {
        if (!entries.has(agent)) entries.set(agent, { lifts: [], deny: [] })
      }
      for (const [agent, entry] of entries) {
        const deny = bridgeDenyNames(toolNameFacts(tools, agent, entry.deny))
        if (deny.length === entry.deny.length && deny.every((name) => entry.deny.includes(name))) continue
        lift(entry)
        if (deny.length === 0) continue
        try {
          if (agent?.ctx?.tools === undefined) continue
          entry.lifts.push(agent.ctx.tools.restrict({ deny }))
          entry.deny = deny
        } catch (error) {
          ctx.logger?.warn?.('dsh-win-pwsh7: bridge could not hide %s: %s', deny.join(', '), describe(error))
        }
      }
    } finally {
      mutating = false
    }
  }
  const disposers = []
  if (typeof ctx.on === 'function') {
    disposers.push(ctx.on('agent/created', ({ agent } = {}) => {
      if (agent !== undefined) entries.set(agent, { lifts: [], deny: [] })
      reconcile()
    }))
    disposers.push(ctx.on('agent/disposed', ({ agent } = {}) => {
      const entry = entries.get(agent)
      if (entry !== undefined) {
        lift(entry)
        entries.delete(agent)
      }
    }))
    disposers.push(ctx.on('tools/change', () => { reconcile() }))
    disposers.push(ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      reconcile()
      return next()
    }))
    disposers.push(ctx.on('app-boot/config-reload', () => { reconcile() }))
    disposers.push(ctx.on('plugin-manager/changed', () => { reconcile() }))
  }
  reconcile()
  return () => {
    stopped = true
    for (const dispose of disposers) dispose?.()
    for (const entry of entries.values()) lift(entry)
    entries.clear()
  }
}

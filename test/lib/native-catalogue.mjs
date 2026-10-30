/** Explicit advanced Native fixture: the real discovery component owns the requested tools. */
import * as file from '../../lib/components/file/index.js'
import * as discovery from '../../lib/discovery/index.js'
import { DISCOVERABLE_TOOLS } from '../../lib/discovery/config.js'
import { legacyComponent } from './legacy-component.mjs'
export function mountNativeCatalogue(ctx, config = {}) {
  return ctx.plugin({ async apply(inner) {
    await inner.plugin(legacyComponent(file), config)
    await inner.plugin(legacyComponent(discovery), { ...config, enabled: false, allowedTools: [...DISCOVERABLE_TOOLS], alwaysLoaded: [...DISCOVERABLE_TOOLS] })
  } })
}

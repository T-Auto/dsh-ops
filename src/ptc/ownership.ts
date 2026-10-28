import type { Context, Agent } from '../adapter/dsh/types.js'
import { ownScopes } from '../scoped-ownership.js'
export const ownPtcScopes = (ctx: Context, changed: () => void, allows?: (agent: Agent) => boolean) => ownScopes(ctx, 'ptc', changed, allows)

/**
 * Repeated-write detection and the model-facing batch-call guidance it injects.
 *
 * The module is a pure kernel: it imports no host values, so a unit test can
 * drive it with plain objects and a fake agent. The caller owns delivery.
 */
import path from 'node:path'
import type { Agent } from '../adapter/dsh/types.js'

/** Identity of the guidance in the host message source. */
export const BATCHING_GUIDANCE_ID = 'batching-guidance'
/** Revision of the guidance text; bump it when the wording changes. */
export const BATCHING_GUIDANCE_REVISION = '1'

/**
 * Chinese batch-call guidance, exactly as the user supplied it. It is delivered
 * through a tool result (never the system prompt) after the tracker fires.
 */
export const BATCHING_GUIDANCE = `# 批量调用工具：
### 核心规则
1. **工具只能在 \`run_code\` 里调用**：写 \`await tools.<名字>(参数)\`。
2. **无依赖 → 并发**：用 \`Promise.all\`，适合只读调用。
3. **有依赖 → 分步**：后一步需要前一步的结果时，用 \`await\` 顺序执行。
4. **单项失败 → 容错**：用 \`try/catch\` 包住单个调用，不影响其他项。
5. **只输出需要的内容**：中间结果不会显示，用 \`return\` 返回摘要。
6. **写操作 → 显式串联**：即使并发提交也按顺序执行，但建议用 \`await\` 写清楚。
### 常见错误

| 错误 | 正确做法 |
|---|---|
| 有依赖的调用放进 \`Promise.all\` | 分步 \`await\` |
| 不加上限(上限128)地并发大量文件 | 先 \`slice\` 截断 |
| 直接 \`return\` 整个大结果 | 只返回需要的字段 |
| 单项失败导致全部中断 | 用 \`try/catch\` 包单项 |
| 用 \`e.toolName\` 当错误原因 | 用 \`e.message\` 取原因 |`

/** Tracker tuning; only the window size is configurable. */
export interface BatchingTrackerOptions {
  /** Consecutive writes to one normalized path that trigger the guidance. Defaults to 3. */
  readonly window?: number
}

/** One recorded write: the API that ran and the path it normalized to. */
export interface BatchingWrite {
  readonly api: string
  readonly path: string
}

/** Outcome of recording one successful write. */
export interface BatchingDecision {
  /** Whether this write crossed the window and should deliver the guidance. */
  readonly shouldNotify: boolean
  /** Turn the guidance belongs to; 0 until the host reported one. */
  readonly turn: number
  /** The normalized path this write named, when the call carried one. */
  readonly path?: string
}

/** Per-agent rolling window of writes and the paths already notified this turn. */
export interface BatchingTracker {
  /** Start a host turn: the write window and notifications reset. Repeated calls with the same turn are no-ops. */
  noteTurn(agent: Agent, turn: number): void
  /** Record one successful write and decide whether the guidance belongs to this tool result. */
  recordWrite(agent: Agent, api: string, args: unknown): BatchingDecision
  /** Drop all state for one agent, on disposal or detachment. */
  forget(agent: Agent): void
}

const DEFAULT_WINDOW = 3

/**
 * Resolve one caller-supplied path against the session cwd, then this process's
 * cwd, so equivalent spellings share one window entry.
 * @param raw - the path exactly as the call carried it.
 * @param cwd - the session working directory, when the host exposes one.
 * @returns the normalized absolute path; the input itself when resolution fails.
 */
export function normalizePath(raw: string, cwd?: string): string {
  try {
    return path.resolve(typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd(), raw)
  } catch {
    try { return path.normalize(raw) } catch { return raw }
  }
}

/** The session working directory, when the agent exposes one. */
function sessionCwd(agent: Agent): string | undefined {
  try {
    const cwd = agent.session?.header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
  } catch { return undefined }
}

/** The path argument of a write call, when it is a usable string. */
function writePath(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const value = (args as { path?: unknown }).path
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') ? value : undefined
}

/**
 * Create one tracker. State is keyed by agent identity and never serialized.
 * A write without a usable `path` argument is ignored, so copy/move destinations
 * and pathless calls never count toward a window.
 * @param options - optional window size; defaults to 3 writes to the same path.
 * @returns the tracker used by the PTC publication.
 */
export function createBatchingTracker(options: BatchingTrackerOptions = {}): BatchingTracker {
  const window = Number.isInteger(options.window) && (options.window as number) >= 1 ? options.window as number : DEFAULT_WINDOW
  const states = new WeakMap<Agent, { turn: number; writes: BatchingWrite[]; notified: Set<string> }>()
  const stateFor = (agent: Agent) => {
    let state = states.get(agent)
    if (state === undefined) {
      state = { turn: 0, writes: [], notified: new Set() }
      states.set(agent, state)
    }
    return state
  }
  return {
    noteTurn(agent, turn) {
      const current = states.get(agent)
      if (current !== undefined && current.turn === turn) return
      states.set(agent, { turn: Number.isSafeInteger(turn) ? turn : 0, writes: [], notified: new Set() })
    },
    recordWrite(agent, api, args) {
      const state = stateFor(agent)
      const raw = writePath(args)
      if (raw === undefined) return { shouldNotify: false, turn: state.turn }
      const normalized = normalizePath(raw, sessionCwd(agent))
      state.writes.push({ api, path: normalized })
      if (state.writes.length > window) state.writes.splice(0, state.writes.length - window)
      const matches = state.writes.filter(entry => entry.path === normalized).length
      // Every window slot names the same path and this turn has not delivered yet.
      if (matches < window || state.notified.has(normalized)) return { shouldNotify: false, turn: state.turn, path: normalized }
      state.notified.add(normalized)
      return { shouldNotify: true, turn: state.turn, path: normalized }
    },
    forget(agent) { states.delete(agent) },
  }
}

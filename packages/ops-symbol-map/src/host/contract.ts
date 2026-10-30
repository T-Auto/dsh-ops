/**
 * 宿主 `src/file/contract.ts` 中 `normalizeArguments` 的等价实现（不依赖 capabilities registry）。
 *
 * 这是宿主契约在本包内的最小副本，符号与宿主同名同义；合并回宿主时应优先用宿主原实现
 * 并删除本文件。
 *
 * 宿主版本做三件事：先按工具名从 capabilities registry 取参数表，再按 `required` 判断可选性，
 * 最后丢掉「严格适配器会发来的空占位」——值为 `undefined`/`null` 的字段，以及可选
 * string 的空白串、可选 array 的空数组。它从不修改调用方对象。
 *
 * 差异边界（本包只有一个工具，参数表是常量，所以不需要 registry）：
 *
 *   1. `PARAMETERS` 在这里是冻结常量，只含 `symbol_map` 一张表；宿主从 registry 取，
 *      同一工具名在两边的字段集合必须保持一致，否则「哪个字段算可选」会分叉。
 *   2. 未知工具名按宿主同款处理：返回浅拷贝，不猜 schema、也不删字段。
 *   3. `scope` 在宿主 schema 里是 string，但引擎的 `normalizeScope` 也接受 `{lo,hi}` 对象。
 *      这里照宿主的类型判断走：只有 `type === 'string'` 才做空白裁剪，对象原样透传。
 *
 * @module dsh-ops/host/contract
 */

type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object'

interface Field { type: FieldType }

interface ParameterTable {
  required: readonly string[]
  properties: Readonly<Record<string, Field>>
}

/** `symbol_map` 的参数表。`path` 是唯一必填项；其余都可选，可选的空占位会被丢掉。 */
const SYMBOL_MAP: ParameterTable = Object.freeze({
  required: Object.freeze(['path']),
  properties: Object.freeze({
    path: Object.freeze({ type: 'string' as const }),
    scope: Object.freeze({ type: 'string' as const }),
    lang: Object.freeze({ type: 'string' as const }),
    offset: Object.freeze({ type: 'number' as const }),
    limit: Object.freeze({ type: 'number' as const }),
    name: Object.freeze({ type: 'string' as const }),
    extended: Object.freeze({ type: 'boolean' as const }),
  }),
})

const PARAMETERS: Readonly<Record<string, ParameterTable>> = Object.freeze({ symbol_map: SYMBOL_MAP })

/**
 * 丢掉严格适配器发来的可选字段空占位；永不修改调用方对象。
 *
 * 与宿主逐分支等价：非对象原样返回、未知工具名浅拷贝、必填字段即使为空也保留
 * （让工具层报「path 必须是非空路径」而不是静默变成缺参）。
 */
export function normalizeArguments(tool: string, args: unknown): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  const schema = Object.hasOwn(PARAMETERS, tool) ? PARAMETERS[tool] : undefined
  if (schema === undefined) return { ...args }
  const required = new Set(schema.required)
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    const field = schema.properties[key]
    if (field !== undefined && !required.has(key)) {
      if (field.type === 'string' && typeof value === 'string' && value.trim() === '') continue
      if (field.type === 'array' && Array.isArray(value) && value.length === 0) continue
    }
    result[key] = value
  }
  return result
}

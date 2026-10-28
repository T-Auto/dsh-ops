/** Public settings descriptors beside the existing strict Standard Schema validators.
 * Settings reads meta.volatile to select editable fields. Keep our own vendor:
 * the loader must remount these components instead of assuming Schemastery refs.
 */
export type Field = {
  type: 'string' | 'boolean' | 'number' | 'array' | 'object'
  meta?: { volatile?: boolean; description?: string }
  inner?: Field
  dict?: Record<string, Field>
}
export interface Descriptor extends Field {
  meta: NonNullable<Field['meta']>
  inner?: Descriptor
  dict?: Record<string, Descriptor>
  toJSON(): Field
}
function descriptor(field: Field): Descriptor {
  return {
    type: field.type, meta: { ...field.meta },
    ...(field.inner ? { inner: descriptor(field.inner) } : {}),
    ...(field.dict ? { dict: Object.fromEntries(Object.entries(field.dict).map(([key, value]) => [key, descriptor(value)])) } : {}),
    // The host strips volatile metadata from its validation copy. Returning a
    // detached tree keeps that operation from corrupting subsequent descriptions.
    toJSON() { return JSON.parse(JSON.stringify({ ...this, toJSON: undefined })) as Field },
  }
}
export const editable = (type: Field['type'], description: string, inner?: Field): Field => ({
  type, meta: { volatile: true, description }, ...(inner ? { inner } : {}),
})
export function settingsConfig<T>(normalize: (value: unknown) => T, fields: Record<string, Field>) {
  return Object.assign(descriptor({ type: 'object', dict: fields }), {
    '~standard': {
      version: 1 as const, vendor: 'dsh-ops',
      validate(value: unknown): { value: T } | { issues: { message: string }[] } {
        try { return { value: normalize(value) } }
        catch (error) { return { issues: [{ message: error instanceof Error ? error.message : String(error) }] } }
      },
    },
  })
}
export function configObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('config must be an object')
  return value as Record<string, unknown>
}

// Codex form elicitations as questions (design §5, task 4.3 Codex portion).
// The `form`, `openai/form` and `openaiForm` modes ask for structured
// content matching a requestedSchema (MCP 2025-11-25 ElicitRequestFormParams:
// a flat object of string, number/integer, boolean, enum and multi-select
// properties). Such a request is published as ONE question through the
// unchanged public callback:
//
// - The question text is the request's message, followed by the exact schema
//   the answer must match. Its two options are `Decline` and `Cancel`; typed
//   text is the answer itself, one JSON object (the local codec).
// - The private captured schema is authoritative: decode() validates the
//   typed text against it (unknown or missing required keys, types, bounds,
//   formats, enum members) and returns the native content. Nothing a host
//   mutates in a published copy changes what validates.
// - A schema this compiler cannot validate faithfully (an unknown keyword,
//   a nested object, a malformed bound) is not narrowed: compileForm()
//   returns its exact shape, which the caller reports once and declines.
import type { AgentQuestion } from '../events.js'
import type { JsonValue } from '../json.js'

export const FORM_MODES = new Set(['form', 'openai/form', 'openaiForm'])
export const DECLINE = 'Decline'
export const CANCEL = 'Cancel'

type Check = (value: unknown, name: string) => string | null
type Decoded = { ok: true; content: Record<string, JsonValue> } | { ok: false; error: string }

export interface CompiledForm {
  question: AgentQuestion
  decode(text: string): Decoded
}

export type FormCompile = { ok: true; form: CompiledForm } | { ok: false; shape: string }

class Unsupported extends Error {}

const COMMON = ['type', 'title', 'description', 'default']
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0
const fragment = (v: unknown) => {
  const text = JSON.stringify(v) ?? String(v)
  return text.length > 400 ? `${text.slice(0, 400)}...` : text
}

function unsupported(path: string, why: string, value: unknown): never {
  throw new Unsupported(`${path} ${why}: ${fragment(value)}`)
}

function onlyKeys(schema: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(schema)) if (!allowed.includes(key)) unsupported(path, `has unsupported keyword "${key}"`, schema)
}

function optional(schema: Record<string, unknown>, key: string, ok: (v: unknown) => boolean, path: string): void {
  if (key in schema && !ok(schema[key])) unsupported(path, `has an invalid "${key}"`, schema)
}

function members(values: unknown, path: string, schema: unknown): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== 'string')) unsupported(path, 'has an invalid enum', schema)
  return values as string[]
}

function consts(options: unknown, path: string, schema: unknown): string[] {
  if (!Array.isArray(options) || options.length === 0) unsupported(path, 'has invalid const options', schema)
  return (options as unknown[]).map((o) => {
    if (!isRecord(o) || typeof o.const !== 'string' || typeof o.title !== 'string' || Object.keys(o).some((k) => k !== 'const' && k !== 'title')) unsupported(path, 'has an invalid const option', schema)
    return o.const as string
  })
}

const FORMATS: Record<string, (s: string) => boolean> = {
  email: (s) => /^[^\s@]+@[^\s@]+$/.test(s),
  uri: (s) => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) && URL.canParse(s),
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s),
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.test(s) && !Number.isNaN(Date.parse(s)),
}

function oneOfSet(allowed: string[]): Check {
  const set = new Set(allowed)
  return (v, name) => (typeof v === 'string' && set.has(v) ? null : `"${name}" must be one of ${JSON.stringify(allowed)}`)
}

function stringCheck(schema: Record<string, unknown>, path: string): Check {
  optional(schema, 'default', (v) => typeof v === 'string', path)
  if ('enum' in schema) {
    onlyKeys(schema, [...COMMON, 'enum', 'enumNames'], path)
    const allowed = members(schema.enum, path, schema)
    optional(schema, 'enumNames', (v) => Array.isArray(v) && v.length === allowed.length && v.every((n) => typeof n === 'string'), path)
    return oneOfSet(allowed)
  }
  if ('oneOf' in schema) {
    onlyKeys(schema, [...COMMON, 'oneOf'], path)
    return oneOfSet(consts(schema.oneOf, path, schema))
  }
  onlyKeys(schema, [...COMMON, 'minLength', 'maxLength', 'format'], path)
  optional(schema, 'minLength', isCount, path)
  optional(schema, 'maxLength', isCount, path)
  optional(schema, 'format', (v) => typeof v === 'string' && v in FORMATS, path)
  const min = schema.minLength as number | undefined
  const max = schema.maxLength as number | undefined
  const format = schema.format as string | undefined
  return (v, name) => {
    if (typeof v !== 'string') return `"${name}" must be a string`
    const length = [...v].length
    if (min !== undefined && length < min) return `"${name}" must have at least ${min} characters`
    if (max !== undefined && length > max) return `"${name}" must have at most ${max} characters`
    if (format && !FORMATS[format]!(v)) return `"${name}" must be a valid ${format}`
    return null
  }
}

function numberCheck(schema: Record<string, unknown>, path: string): Check {
  onlyKeys(schema, [...COMMON, 'minimum', 'maximum'], path)
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  optional(schema, 'minimum', finite, path)
  optional(schema, 'maximum', finite, path)
  optional(schema, 'default', finite, path)
  const integer = schema.type === 'integer'
  const min = schema.minimum as number | undefined
  const max = schema.maximum as number | undefined
  return (v, name) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return `"${name}" must be a number`
    if (integer && !Number.isInteger(v)) return `"${name}" must be an integer`
    if (min !== undefined && v < min) return `"${name}" must be at least ${min}`
    if (max !== undefined && v > max) return `"${name}" must be at most ${max}`
    return null
  }
}

function arrayCheck(schema: Record<string, unknown>, path: string): Check {
  onlyKeys(schema, [...COMMON, 'items', 'minItems', 'maxItems'], path)
  optional(schema, 'minItems', isCount, path)
  optional(schema, 'maxItems', isCount, path)
  optional(schema, 'default', (v) => Array.isArray(v) && v.every((s) => typeof s === 'string'), path)
  const items = schema.items
  if (!isRecord(items)) unsupported(path, 'has invalid items', schema)
  let allowed: string[]
  if ('anyOf' in items) {
    onlyKeys(items, ['anyOf'], `${path}.items`)
    allowed = consts(items.anyOf, `${path}.items`, items)
  } else {
    onlyKeys(items, ['type', 'enum'], `${path}.items`)
    if (items.type !== 'string') unsupported(`${path}.items`, 'has an unsupported type', items)
    allowed = members(items.enum, `${path}.items`, items)
  }
  const set = new Set(allowed)
  const min = schema.minItems as number | undefined
  const max = schema.maxItems as number | undefined
  return (v, name) => {
    if (!Array.isArray(v)) return `"${name}" must be an array`
    if (v.some((item) => typeof item !== 'string' || !set.has(item))) return `"${name}" items must be among ${JSON.stringify(allowed)}`
    if (min !== undefined && v.length < min) return `"${name}" must have at least ${min} items`
    if (max !== undefined && v.length > max) return `"${name}" must have at most ${max} items`
    return null
  }
}

function propertyCheck(schema: unknown, path: string): Check {
  if (!isRecord(schema)) unsupported(path, 'is not a schema object', schema)
  switch (schema.type) {
    case 'string': return stringCheck(schema, path)
    case 'number':
    case 'integer': return numberCheck(schema, path)
    case 'boolean':
      onlyKeys(schema, COMMON, path)
      optional(schema, 'default', (v) => typeof v === 'boolean', path)
      return (v, name) => (typeof v === 'boolean' ? null : `"${name}" must be true or false`)
    case 'array': return arrayCheck(schema, path)
    default: return unsupported(path, 'has an unsupported type', schema)
  }
}

/** Compile one form elicitation's requestedSchema; never narrows an unsupported shape. */
export function compileForm(params: Record<string, unknown>): FormCompile {
  const mode = String(params.mode)
  const schema = params.requestedSchema
  try {
    if (!isRecord(schema)) unsupported('requestedSchema', 'is not an object schema', schema)
    onlyKeys(schema, ['$schema', 'type', 'properties', 'required'], 'requestedSchema')
    if (schema.type !== 'object') unsupported('requestedSchema', 'is not of type "object"', schema)
    optional(schema, '$schema', (v) => typeof v === 'string', 'requestedSchema')
    if (!isRecord(schema.properties)) unsupported('requestedSchema', 'has no properties object', schema)
    const properties = schema.properties as Record<string, unknown>
    const checks = new Map(Object.entries(properties).map(([name, property]) => [name, propertyCheck(property, `requestedSchema.properties.${name}`)] as const))
    const required = schema.required ?? []
    if (!Array.isArray(required) || required.some((name) => typeof name !== 'string' || !checks.has(name))) unsupported('requestedSchema', 'has an invalid "required"', schema)
    const requiredNames = [...(required as string[])]
    const message = typeof params.message === 'string' ? params.message : ''
    const question: AgentQuestion = {
      question: `${message}\n\nAnswer with one JSON object matching this schema: ${JSON.stringify(schema)}`,
      header: typeof params.serverName === 'string' && params.serverName ? params.serverName : 'Form',
      multiSelect: false,
      options: [{ label: DECLINE, description: 'Decline the request' }, { label: CANCEL, description: 'Cancel the request' }],
      isOther: true,
    }
    const decode = (text: string): Decoded => {
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        return { ok: false, error: 'The answer must be one JSON object' }
      }
      if (!isRecord(value)) return { ok: false, error: 'The answer must be one JSON object' }
      for (const name of Object.keys(value)) if (!checks.has(name)) return { ok: false, error: `"${name}" is not a field of this form` }
      for (const name of requiredNames) if (!Object.hasOwn(value, name)) return { ok: false, error: `"${name}" is required` }
      for (const [name, field] of Object.entries(value)) {
        const error = checks.get(name)!(field, name)
        if (error) return { ok: false, error }
      }
      return { ok: true, content: value as Record<string, JsonValue> }
    }
    return { ok: true, form: { question, decode } }
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error
    return { ok: false, shape: `elicitation mode ${JSON.stringify(mode)}: ${error.message}; it was declined` }
  }
}

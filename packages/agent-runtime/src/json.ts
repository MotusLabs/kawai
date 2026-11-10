// JSON value types for everything the runtime hands a caller: events,
// opaque submit context, tool inputs and results (design §6: no runtime
// object, Error or callback crosses the public boundary), and the total
// normalizer the event stream applies to every event.

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

/**
 * Any value as a JSON value, totally (it never throws): what JSON.stringify
 * keeps stays as is; a non-finite number is null; a bigint is its decimal
 * string; undefined, a function or a symbol is dropped from an object and
 * null in an array; a value with toJSON (a Date) is its result; a repeated
 * ancestor (a cycle) is null. So an event survives a JSONL round-trip
 * unchanged.
 */
export function toJsonValue(value: unknown): JsonValue {
  return normalize(value, new Set()) ?? null
}

function normalize(value: unknown, ancestors: Set<object>): JsonValue | undefined {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : null
    case 'bigint':
      return value.toString()
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined
  }
  if (value === null) return null
  const object = value as object
  if (ancestors.has(object)) return null
  const toJSON = (object as { toJSON?: unknown }).toJSON
  if (typeof toJSON === 'function') {
    let replaced: unknown
    try {
      replaced = toJSON.call(object)
    } catch {
      return null
    }
    if (replaced !== object) return normalize(replaced, ancestors)
  }
  ancestors.add(object)
  try {
    if (Array.isArray(object)) return object.map((item) => normalize(item, ancestors) ?? null)
    const out: JsonObject = {}
    for (const key of Object.keys(object)) {
      let item: unknown
      try {
        item = (object as Record<string, unknown>)[key]
      } catch {
        continue
      }
      const json = normalize(item, ancestors)
      if (json !== undefined) out[key] = json
    }
    return out
  } finally {
    ancestors.delete(object)
  }
}

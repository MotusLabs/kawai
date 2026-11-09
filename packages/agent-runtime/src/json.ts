// JSON value types for everything the runtime hands a caller: events,
// opaque submit context, tool inputs and results (design §6: no runtime
// object, Error or callback crosses the public boundary).

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

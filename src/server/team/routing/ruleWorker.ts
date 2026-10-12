// Worker side of a routing rule (profile-routing design D1/D2). Runs inside
// a Bun Worker started with an explicit, minimal environment. `load` imports
// the user's rule module and reports its declared `env` and `timeoutMs`;
// `call` runs `route` or `onLimit` and posts the result back. Module state
// persists between calls, so a rule may cache what it looks up.
export {}

type Inbound =
  | { type: 'load'; url: string }
  | { type: 'call'; id: number; method: 'route' | 'onLimit'; payload: unknown }

interface LoadedRule {
  route?: unknown
  onLimit?: unknown
  env?: unknown
  timeoutMs?: unknown
}

let rule: LoadedRule | null = null

/** Build failures arrive as one error carrying the individual ones: name them all. */
const message = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  const parts = (error as { errors?: unknown }).errors
  if (!Array.isArray(parts) || parts.length === 0) return error.message
  return `${error.message}: ${parts.map(part => (part instanceof Error ? part.message : String(part))).join('; ')}`
}

self.onmessage = async (event: MessageEvent<Inbound>) => {
  const data = event.data
  if (data.type === 'load') {
    try {
      const mod = (await import(data.url)) as { default?: LoadedRule }
      const loaded = mod.default
      if (!loaded || typeof loaded !== 'object') throw new Error('the rule must default-export an object')
      if (typeof loaded.route !== 'function') throw new Error('the rule must have a route function')
      if (loaded.onLimit !== undefined && typeof loaded.onLimit !== 'function') throw new Error('onLimit must be a function')
      if (loaded.env !== undefined && !(Array.isArray(loaded.env) && loaded.env.every(key => typeof key === 'string'))) {
        throw new Error('env must be a list of variable names')
      }
      if (loaded.timeoutMs !== undefined && !(typeof loaded.timeoutMs === 'number' && loaded.timeoutMs > 0)) {
        throw new Error('timeoutMs must be a positive number')
      }
      rule = loaded
      postMessage({
        type: 'loaded',
        env: (loaded.env as string[] | undefined) ?? [],
        timeoutMs: loaded.timeoutMs ?? null,
        hasOnLimit: typeof loaded.onLimit === 'function',
      })
    } catch (error) {
      postMessage({ type: 'load-error', error: message(error) })
    }
    return
  }
  try {
    const fn = rule?.[data.method]
    if (typeof fn !== 'function') throw new Error(`the rule has no ${data.method} function`)
    const value = await (fn as (payload: unknown) => unknown).call(rule, data.payload)
    postMessage({ type: 'result', id: data.id, ok: true, value })
  } catch (error) {
    postMessage({ type: 'result', id: data.id, ok: false, error: message(error) })
  }
}

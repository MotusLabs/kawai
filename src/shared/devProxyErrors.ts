// Classifies Vite dev-proxy errors that are expected during normal operation,
// so the dev server can drop them instead of logging a stack trace.

const BENIGN_PROXY_ERROR_CODES = [
  // Backend is restarting under `bun --watch`; the next request reconnects.
  'ECONNREFUSED',
  // Browser reloaded or closed the tab while the proxy was piping terminal
  // output, so the socket the proxy writes to is already gone.
  'ECONNRESET',
  'EPIPE',
  'ERR_STREAM_WRITE_AFTER_END',
] as const

const PROXY_ERROR_LOG = /(?:http|ws) proxy (?:socket )?error/

export function isBenignProxyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false

  const anyErr = err as { code?: unknown; message?: unknown; errors?: unknown }
  if (typeof anyErr.code === 'string') {
    if ((BENIGN_PROXY_ERROR_CODES as readonly string[]).includes(anyErr.code)) return true
  }

  // Node can surface dual-stack localhost failures as an AggregateError.
  if (Array.isArray(anyErr.errors) && anyErr.errors.some(isBenignProxyError)) return true

  const message = anyErr.message
  if (typeof message !== 'string') return false
  return BENIGN_PROXY_ERROR_CODES.some((code) => message.includes(code))
}

// Vite logs proxy failures as `http proxy error:` / `ws proxy error:` /
// `ws proxy socket error:` with the error attached. Only those messages are
// eligible for suppression, and only when the error itself is benign.
export function shouldSuppressProxyLog(msg: string, error?: unknown): boolean {
  if (!PROXY_ERROR_LOG.test(msg)) return false
  // Vite always attaches the error; fall back to the message (which embeds the
  // stack) so a future logger call without one still classifies correctly.
  return isBenignProxyError(error ?? { message: msg })
}

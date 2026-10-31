// Object ids are literal lowercase hex of the repository's format. This is
// deliberately separate from the result checker's permissive ref resolver.
import type { ObjectFormat } from './types'

export function isFullLiteral(value: unknown, format: ObjectFormat): value is string {
  return typeof value === 'string' && value.length === (format === 'sha256' ? 64 : 40)
    && /^[0-9a-f]+$/.test(value)
}

// Presentation helpers for captured chat wire frames: a short message-type
// label derived from the stream-json shape, and pretty-printed content. The
// raw line stays the source of truth; parsing here is display-only.
import type { ChatWireFrame } from '@shared/chat'

export function parseFrame(frame: ChatWireFrame): unknown {
  try {
    return JSON.parse(frame.raw)
  } catch {
    return undefined
  }
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
const obj = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/**
 * `type` plus the most specific sub-kind the frame carries: `subtype`,
 * `request.subtype` / `response.subtype` (control traffic), `event.type`
 * (stream_event), or the lifecycle `event`. Non-JSON lines read as `text`.
 */
export function frameLabel(frame: ChatWireFrame): string {
  const value = obj(parseFrame(frame))
  if (!value) return 'text'
  if (frame.dir === 'lifecycle') return str(value.event) ?? 'lifecycle'
  const type = str(value.type)
  if (!type) return 'json'
  const detail = str(value.subtype) ??
    str(obj(value.request)?.subtype) ??
    str(obj(value.response)?.subtype) ??
    str(obj(value.event)?.type)
  return detail ? `${type} · ${detail}` : type
}

/** Pretty JSON for valid JSON frames, otherwise the raw line. */
export function prettyFrame(frame: ChatWireFrame): string {
  const value = parseFrame(frame)
  return value === undefined ? frame.raw : JSON.stringify(value, null, 2)
}

export const DIRECTION_LABELS: Record<ChatWireFrame['dir'], string> = {
  out: '→ Claude',
  in: '← Claude',
  stderr: 'stderr',
  lifecycle: 'process',
}

/** Local time with milliseconds, e.g. 14:03:07.215. */
export function frameTime(frame: ChatWireFrame): string {
  const date = new Date(frame.at)
  if (Number.isNaN(date.getTime())) return frame.at
  const pad = (value: number, length = 2) => String(value).padStart(length, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

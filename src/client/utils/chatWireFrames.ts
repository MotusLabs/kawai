// Presentation helpers for captured chat wire frames: a short message-type
// label derived from the stream-json shape, pretty-printed content, and
// grouping of consecutive same-type frames into collapsed display runs. The
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

/**
 * Labels that may sit inside a run without ending it. Thinking deltas strictly
 * alternate with `system · thinking_tokens`, so a run keyed only on the delta
 * label would never span them; absorbing them keeps ~75% of a streamed
 * response (the thinking) groupable.
 */
const TRANSPARENT_LABELS: ReadonlySet<string> = new Set(['system · thinking_tokens'])

/** One display entry: an ungrouped frame, or a collapsed run of frames. */
export type FrameEntry =
  | { kind: 'frame'; frame: ChatWireFrame }
  | { kind: 'group'; label: string; dir: ChatWireFrame['dir']; frames: ChatWireFrame[]; absorbed: number }

/**
 * Group consecutive frames that share a direction and `frameLabel` into one
 * entry per run. Transparent-label frames join whatever run is open under the
 * same direction instead of ending it; with no run open they start one under
 * their own label. A run of one frame stays a plain frame entry. Members keep
 * seq order; flattening every entry's frames reproduces the input exactly.
 */
export function groupFrames(frames: readonly ChatWireFrame[]): FrameEntry[] {
  const entries: FrameEntry[] = []
  let run: { label: string; dir: ChatWireFrame['dir']; frames: ChatWireFrame[]; absorbed: number } | undefined
  const close = () => {
    if (!run) return
    entries.push(run.frames.length === 1
      ? { kind: 'frame', frame: run.frames[0]! }
      : { kind: 'group', label: run.label, dir: run.dir, frames: run.frames, absorbed: run.absorbed })
    run = undefined
  }
  for (const frame of frames) {
    const label = frameLabel(frame)
    if (run && frame.dir === run.dir && (label === run.label || TRANSPARENT_LABELS.has(label))) {
      if (label !== run.label) run.absorbed += 1
      run.frames.push(frame)
    } else {
      close()
      run = { label, dir: frame.dir, frames: [frame], absorbed: 0 }
    }
  }
  close()
  return entries
}

/** Local time with milliseconds, e.g. 14:03:07.215. */
export function frameTime(frame: ChatWireFrame): string {
  const date = new Date(frame.at)
  if (Number.isNaN(date.getTime())) return frame.at
  const pad = (value: number, length = 2) => String(value).padStart(length, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

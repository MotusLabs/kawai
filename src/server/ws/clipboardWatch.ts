// Clipboard buffer watch: while a local terminal is attached, poll tmux's
// paste buffers and offer a newly created buffer to the client as a
// clipboard write — but only when a left-button mouse gesture armed the
// watch and the buffer was created at/after that gesture. The per-socket
// generation counter (`clipboardWatchGen`) and in-flight flag are
// load-bearing race guards and moved verbatim from index.ts.
import type { ServerWebSocket } from 'bun'
import { logger } from '../logger'
import type { Session } from '../../shared/types'
import type { SessionRegistry } from '../SessionRegistry'
import { readTmuxCapture } from '../tmuxCapture'
import { buildTmuxFormat, splitTmuxFields, splitTmuxLines } from '../tmuxFormat'
import type { ConnectionHub } from './ConnectionHub'
import { fireAndForget } from './ConnectionHub'
import type { WSData } from './wsTypes'

const CLIPBOARD_BUFFER_POLL_MS = 750
const CLIPBOARD_BUFFER_MAX_BYTES = 512 * 1024
export const CLIPBOARD_BUFFER_ARM_MS = 5000
const SGR_MOUSE_INPUT_RE = new RegExp(
  `${String.fromCharCode(0x1b)}\\[<(\\d+);\\d+;\\d+[Mm]`,
  'g'
)

export interface ClipboardWatchContext {
  registry: SessionRegistry
  hub: ConnectionHub
}

interface TmuxBufferSummary {
  name: string
  created: number
  size: number
  // Monotonic index parsed from tmux's automatic buffer name (buffer0001,
  // buffer0002, …); -1 for explicitly named buffers. Used as the recency
  // tiebreaker when buffer_created collides at whole-second resolution.
  order: number
  key: string
}

function parseTmuxBufferSummaries(output: string): TmuxBufferSummary[] {
  const summaries: TmuxBufferSummary[] = []
  for (const line of splitTmuxLines(output)) {
    const parts = splitTmuxFields(line, 3)
    if (!parts) continue
    const name = parts[0]?.trim()
    const created = Number.parseInt(parts[1] ?? '', 10)
    const size = Number.parseInt(parts[2] ?? '', 10)
    if (!name || !Number.isFinite(created) || !Number.isFinite(size)) continue
    // Only tmux's automatic buffers (buffer0001, buffer0002, …) carry a
    // monotonic index. Explicitly named buffers (e.g. set-buffer -b snippet5)
    // get -1 so their trailing digits don't masquerade as recency.
    const orderMatch = name.match(/^buffer(\d+)$/)
    const order = orderMatch ? Number.parseInt(orderMatch[1], 10) : -1
    summaries.push({
      name,
      created,
      size,
      order,
      key: `${name}:${created}:${size}`,
    })
  }
  // Newest first. tmux's #{buffer_created} is whole-second resolution, so when
  // two buffers share a second, tiebreak by the monotonic automatic-buffer
  // index (buffer0002 newer than buffer0001) rather than size, which carries
  // no recency information.
  summaries.sort((a, b) => b.created - a.created || b.order - a.order || b.size - a.size)
  return summaries
}

async function readLatestTmuxBufferSummary(): Promise<TmuxBufferSummary | null> {
  const stdout = await readTmuxCapture([
    'list-buffers',
    '-F',
    buildTmuxFormat(['#{buffer_name}', '#{buffer_created}', '#{buffer_size}']),
  ])
  if (stdout === null) return null
  return parseTmuxBufferSummaries(stdout)[0] ?? null
}

async function readTmuxBufferText(summary: TmuxBufferSummary): Promise<string | null> {
  if (summary.size <= 0 || summary.size > CLIPBOARD_BUFFER_MAX_BYTES) {
    return null
  }
  const text = await readTmuxCapture(['show-buffer', '-b', summary.name])
  if (text === null) return null
  return text.trim() ? text : null
}

export function stopClipboardBufferWatch(ws: ServerWebSocket<WSData>) {
  if (ws.data.clipboardPollTimer !== null) {
    clearInterval(ws.data.clipboardPollTimer)
  }
  // Bump the generation so any in-flight baseline read or poll from the watch
  // we're tearing down can't write back into a later watch on this socket.
  ws.data.clipboardWatchGen += 1
  ws.data.clipboardPollTimer = null
  ws.data.clipboardPollInFlight = false
  ws.data.lastClipboardBufferKey = null
  ws.data.clipboardBufferArmedUntil = 0
  ws.data.clipboardArmedAtSec = 0
}

export function startClipboardBufferWatch(
  ctx: ClipboardWatchContext,
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  session: Session
) {
  stopClipboardBufferWatch(ws)

  if (session.remote) {
    return
  }

  const gen = ws.data.clipboardWatchGen
  ws.data.clipboardPollTimer = setInterval(() => {
    fireAndForget(pollClipboardBuffer(ctx, ws, sessionId, gen), 'pollClipboardBuffer')
  }, CLIPBOARD_BUFFER_POLL_MS)
  // Establish the baseline asynchronously so a pre-existing buffer isn't offered
  // on the first poll. Skip if this watch was already armed (a copy may have
  // landed before the read resolved — don't watermark the user's own buffer;
  // the created-time gate handles a genuinely pre-existing one) or superseded.
  fireAndForget(
    (async () => {
      const initial = await readLatestTmuxBufferSummary()
      if (
        ws.data.clipboardWatchGen === gen &&
        ws.data.lastClipboardBufferKey === null &&
        ws.data.clipboardBufferArmedUntil === 0
      ) {
        ws.data.lastClipboardBufferKey = initial?.key ?? null
      }
    })(),
    'clipboardBaseline'
  )
}

async function pollClipboardBuffer(
  ctx: ClipboardWatchContext,
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  gen: number
) {
  const { registry, hub } = ctx
  const { sockets, send } = hub
  if (ws.data.clipboardWatchGen !== gen) return
  if (ws.data.clipboardPollInFlight) return
  if (!sockets.has(ws)) return
  if (ws.data.currentSessionId !== sessionId) return

  const session = registry.get(sessionId)
  if (!session || session.remote) return

  ws.data.clipboardPollInFlight = true
  try {
    const latest = await readLatestTmuxBufferSummary()
    // The read yields the event loop, so the watch may have been torn down or
    // the socket may have switched sessions while tmux ran. Re-validate before
    // touching state or offering.
    if (ws.data.clipboardWatchGen !== gen) return
    if (!sockets.has(ws) || ws.data.currentSessionId !== sessionId) return
    if (!latest) {
      ws.data.lastClipboardBufferKey = null
      return
    }
    if (latest.key === ws.data.lastClipboardBufferKey) {
      return
    }

    ws.data.lastClipboardBufferKey = latest.key
    if (Date.now() > ws.data.clipboardBufferArmedUntil) {
      logger.debug('clipboard_buffer_watermarked', {
        sessionId,
        bufferName: latest.name,
        bytes: latest.size,
        connectionId: ws.data.connectionId,
      })
      return
    }

    // Only offer buffers created at/after the arming gesture. A pre-existing or
    // unrelated (cross-window) buffer that becomes "latest" while armed has an
    // older creation time and is skipped, so it can't clobber the clipboard.
    if (latest.created < ws.data.clipboardArmedAtSec) {
      logger.debug('clipboard_buffer_precedes_arm', {
        sessionId,
        bufferName: latest.name,
        createdSec: latest.created,
        armedAtSec: ws.data.clipboardArmedAtSec,
        connectionId: ws.data.connectionId,
      })
      return
    }

    const text = await readTmuxBufferText(latest)
    if (!text) {
      logger.debug('clipboard_buffer_skipped', {
        sessionId,
        bufferName: latest.name,
        bytes: latest.size,
        connectionId: ws.data.connectionId,
      })
      return
    }

    // Re-validate again after the second tmux read before delivering, so we
    // never push a session A offer to a socket that has closed or moved to B.
    if (ws.data.clipboardWatchGen !== gen) return
    if (!sockets.has(ws) || ws.data.currentSessionId !== sessionId) return

    logger.debug('clipboard_buffer_offer', {
      sessionId,
      bufferName: latest.name,
      bytes: latest.size,
      connectionId: ws.data.connectionId,
    })
    send(ws, { type: 'clipboard-offer', sessionId, text, source: 'tmux-buffer' })
    ws.data.clipboardBufferArmedUntil = 0
    ws.data.clipboardArmedAtSec = 0
  } finally {
    // Only release the in-flight guard if the watch is still ours. If it was
    // stopped/restarted mid-poll, stopClipboardBufferWatch already reset the
    // guard for the new generation and we must not clear it out from under it.
    if (ws.data.clipboardWatchGen === gen) {
      ws.data.clipboardPollInFlight = false
    }
  }
}

// Arm the clipboard buffer watch on any left-button mouse event (press, drag,
// or release). This covers every selection style that copies to a tmux paste
// buffer — drag-select, double-click (word) and triple-click (line), which
// emit button-0 events with no motion bit. Bare taps also match, but they
// can't clobber the clipboard: the poll additionally requires the buffer to
// have been created at/after the gesture (see clipboardArmedAtSec), so a tap
// that copies nothing simply never produces an offer.
// SGR encoding: low 2 bits = button (0 = left), bits 6-7 (0xC0) = wheel/extended.
export function containsClipboardArmingMouseInput(data: string): boolean {
  SGR_MOUSE_INPUT_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SGR_MOUSE_INPUT_RE.exec(data)) !== null) {
    const button = Number(match[1])
    if ((button & 3) === 0 && (button & 0xc0) === 0) {
      return true
    }
  }
  return false
}

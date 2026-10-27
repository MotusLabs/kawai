// Pure layout of a chat transcript (chat-transcript-layout D1, D2): pairs tool
// results with their calls, then decides per row where turns and author runs
// begin and where a local day separator goes. Message rows (user, peer,
// assistant) carry an author; every other row is an aside aligned with the
// body column. Turn boundaries come from user, peer, and triggered
// `turn_started` rows plus turn-id changes, so a replayed transcript — which
// has no `turn_completed` — separates turns exactly like a live one. Rows are
// never merged or reordered here.
import type { ChatEvent } from '@shared/chat'
import type { AgentType } from '@shared/types'
import { chatDayKey, chatDayLabel } from '../../utils/chatTimeFormat'

type ToolResult = Extract<ChatEvent, { type: 'tool_result' }>
export type TranscriptEntry = { event: ChatEvent; result?: ToolResult }

export interface RowLayout {
  /** Author key of a message row (`user`, `agent`, `peer:<id>`); null for asides. */
  author: string | null
  /** First row of a turn (not the transcript's first row): wide separation. */
  turnStart: boolean
  /** First message row of an author run within a turn: label and a quiet divider. */
  authorStart: boolean
  /** Local day label to show before this row, when its day differs. */
  dayBreak: string | null
}

/** Attach later results to the earlier call while preserving transcript order. */
export function toolEntries(events: ChatEvent[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  const calls = new Map<string, TranscriptEntry>()
  for (const event of events) {
    if (event.type === 'tool_result') {
      const call = calls.get(event.toolCallId)
      if (call) {
        call.result = event
        continue
      }
    }
    const entry: TranscriptEntry = { event }
    entries.push(entry)
    if (event.type === 'tool_call') calls.set(event.toolCallId, entry)
  }
  return entries
}

/**
 * A row the transcript draws. A user-started `turn_started` draws nothing,
 * and so does a trigger without a usable cause — the generic "continued on
 * its own" line and an empty task list (quiet unknown turns, ui838). Hidden
 * triggered rows stay in `layoutRows`' input so the turn they open keeps its
 * boundary and separation on the next visible row.
 */
export function isVisibleEntry({ event }: TranscriptEntry): boolean {
  if (event.type !== 'turn_started') return true
  if (event.trigger === undefined) return false
  return event.trigger.kind === 'task' && event.trigger.tasks.length > 0
}

function authorOf(event: ChatEvent): string | null {
  switch (event.type) {
    case 'user_message': return 'user'
    case 'assistant_text': return 'agent'
    case 'peer_message': return `peer:${event.senderSession ?? event.senderKind ?? 'unknown'}`
    default: return null
  }
}

function startsTurn(event: ChatEvent): boolean {
  return event.type === 'user_message' || event.type === 'peer_message' ||
    (event.type === 'turn_started' && event.trigger !== undefined)
}

function turnIdOf(event: ChatEvent): string | null {
  return 'turnId' in event && typeof event.turnId === 'string' ? event.turnId : null
}

/**
 * Lay out visible entries. `today` (a `chatDayKey`) adds a leading separator
 * when the first dated message is from another day; day separators key on the
 * previous *dated* message, so an undated one neither adds nor suppresses one.
 */
export function layoutRows(
  entries: TranscriptEntry[],
  options: { today?: string | null; timeZone?: string } = {}
): RowLayout[] {
  const layouts: RowLayout[] = []
  let previousTurn: string | null = null
  let runAuthor: string | null = null
  let previousDay: string | null = null
  // A hidden trigger row still opens its turn: its wide separation carries
  // to the next visible row, so hiding the line never hides the boundary.
  let hiddenTurnStart = false
  entries.forEach(({ event }, index) => {
    // A user-started turn_started draws nothing and always has (it was
    // filtered before layout): leave every layout input untouched.
    if (event.type === 'turn_started' && event.trigger === undefined) {
      layouts.push({ author: null, turnStart: false, authorStart: false, dayBreak: null })
      return
    }
    const author = authorOf(event)
    const turnId = turnIdOf(event)
    const turnStart = index > 0 && (startsTurn(event) ||
      (turnId !== null && previousTurn !== null && turnId !== previousTurn))
    if (turnStart || index === 0) runAuthor = null
    if (turnId !== null) previousTurn = turnId
    const authorStart = author !== null && author !== runAuthor
    if (author !== null) runAuthor = author
    let dayBreak: string | null = null
    const day = author !== null ? chatDayKey(event.at, options.timeZone) : null
    if (day !== null) {
      const differs = previousDay === null ? options.today != null && day !== options.today : day !== previousDay
      if (differs) dayBreak = chatDayLabel(event.at, options.timeZone)
      previousDay = day
    }
    const visible = isVisibleEntry({ event })
    const rowTurnStart = visible && (turnStart || hiddenTurnStart)
    hiddenTurnStart = !visible && (turnStart || hiddenTurnStart)
    layouts.push({ author, turnStart: rowTurnStart, authorStart, dayBreak })
  })
  return layouts
}

/** The agent's author label, from the session's agent kind — never its model. */
export function agentLabelOf(agentType: AgentType | undefined): string {
  switch (agentType) {
    case 'codex': return 'Codex'
    case 'pi': return 'Pi'
    default: return 'Claude'
  }
}

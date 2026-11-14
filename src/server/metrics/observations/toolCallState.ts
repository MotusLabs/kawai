// Bounded transactional tool state (tool-call-metrics D1-D6).
// Foreign names live only in the caller's rollback-owned slot map.
import { classifyToolResult, recognizeTool, PUBLIC_BUILT_IN_LABELS, type TeamCatalogue, type ToolRecognition } from './toolCalls'

export type Mode = 'observing' | 'tainted' | 'saturated'
export interface Call {
  id: string
  identity: string
  kind: ToolRecognition['kind']
  label: string
  recognition: ToolRecognition
  outcome: 'pending' | 'success' | 'failed' | 'quarantined'
  denied: boolean
}
export interface Link {
  id: string
  callId: string | null
  state: 'pending' | 'denied-await-call' | 'transferred' | 'allowed' | 'cancelled' | 'unlinked'
}
export interface Streak {
  identity: string
  kind: ToolRecognition['kind']
  label: string
  length: number
  firstCallId: string
  firstAt: string
}
export interface ClosedStreak extends Streak {
  resolution: 'recovered' | 'abandoned' | 'unknown'
  closedAt: string
}
export interface ToolState {
  version: 1
  calls: Call[]
  links: Link[]
  firsts: { identity: string; callId: string }[]
  streaks: Streak[]
  slots: number
  mode: Mode
  firstHistoryUnknown: boolean
  denialIncomplete: boolean
  seenRecorderFailures: number
}
export function newToolState(failures: number): ToolState {
  return { version: 1, calls: [], links: [], firsts: [], streaks: [], slots: 0,
    mode: 'observing', firstHistoryUnknown: false, denialIncomplete: false,
    seenRecorderFailures: Number.isSafeInteger(failures) && failures >= 0 ? failures : 0 }
}
export function publicToolLabel(tool: ToolRecognition, catalogue: TeamCatalogue): string {
  if (tool.kind === 'builtin') return (PUBLIC_BUILT_IN_LABELS as readonly string[]).includes(tool.name) ? tool.name : 'other'
  if (tool.kind === 'team') {
    const names = [...catalogue.members].slice(0, 76).map(name => name.slice(catalogue.prefix.length))
    return names.includes(tool.name) ? tool.name : 'other'
  }
  return tool.label
}
const same = (a: Pick<Call, 'identity' | 'kind'>, b: Pick<Call, 'identity' | 'kind'>) => a.identity === b.identity && a.kind === b.kind
export function closeStreaks(s: ToolState, resolution: ClosedStreak['resolution'], at: string): ClosedStreak[] {
  const closed = s.streaks.map(streak => ({ ...streak, resolution, closedAt: at }))
  s.streaks = []
  return closed
}
export function taint(s: ToolState, at: string, saturated = false): ClosedStreak[] {
  s.firstHistoryUnknown = true
  if (saturated) s.mode = 'saturated'
  else if (s.mode !== 'saturated') s.mode = 'tainted'
  return closeStreaks(s, 'unknown', at)
}
export function watchFailures(s: ToolState, failures: number, at: string): ClosedStreak[] {
  const gap = !Number.isSafeInteger(failures) || failures < 0 ||
    !Number.isSafeInteger(s.seenRecorderFailures) || failures !== s.seenRecorderFailures
  s.seenRecorderFailures = Number.isSafeInteger(failures) && failures >= 0 ? failures : 0
  return gap ? taint(s, at) : []
}
export function admitCall(s: ToolState, slots: Map<string, number>, id: string, raw: string,
  catalogue: TeamCatalogue, at: string): ClosedStreak[] {
  if (s.calls.some(call => call.id === id)) return []
  if (s.calls.length === 512) return s.mode === 'saturated' ? [] : taint(s, at, true)
  const recognition = recognizeTool(raw, catalogue)
  let identity = 'unknown'
  if (recognition.kind === 'builtin' || recognition.kind === 'team') identity = recognition.name
  else if (recognition.kind === 'foreign') {
    let slot = slots.get(raw)
    if (slot === undefined && s.slots < 96) {
      slot = ++s.slots
      slots.set(raw, slot)
    }
    if (slot !== undefined) identity = 'slot-' + slot
  }
  const call: Call = { id, identity, kind: recognition.kind, recognition,
    label: publicToolLabel(recognition, catalogue), outcome: 'pending', denied: false }
  s.calls.push(call)
  if (recognition.kind === 'team' && !s.firsts.some(first => first.identity === identity)) {
    s.firsts.push({ identity, callId: id })
  }
  for (const link of s.links) if (link.callId === id && link.state === 'denied-await-call') {
    call.denied = true
    link.state = 'transferred'
  }
  return []
}
export function approval(s: ToolState, id: string, callId: string | null): void {
  if (s.links.some(link => link.id === id)) return
  if (s.links.length === 64) { s.denialIncomplete = true; return }
  const call = s.calls.find(value => value.id === callId)
  s.links.push({ id, callId, state: call && call.outcome !== 'pending' ? 'unlinked' : 'pending' })
}
export function resolveApproval(s: ToolState, id: string, outcome: string): void {
  const link = s.links.find(value => value.id === id)
  if (!link) {
    if (outcome !== 'denied') return
    s.denialIncomplete = true
    if (s.links.length < 64) s.links.push({ id, callId: null, state: 'unlinked' })
    return
  }
  if (link.state !== 'pending') return
  if (outcome !== 'denied') { link.state = outcome === 'allowed' ? 'allowed' : 'cancelled'; return }
  const call = s.calls.find(value => value.id === link.callId)
  if (!link.callId || (call && call.outcome !== 'pending')) {
    link.state = 'unlinked'
    s.denialIncomplete = true
  } else if (call) {
    call.denied = true
    link.state = 'transferred'
  } else link.state = 'denied-await-call'
}
export interface Result {
  duplicate: boolean
  eligible: boolean
  call?: Call
  first: boolean
  failureClass?: string
  closed: ClosedStreak[]
}
export function settleCall(s: ToolState, id: string, failed: boolean, output: string, at: string): Result {
  const call = s.calls.find(value => value.id === id)
  if (!call) {
    const closed = s.calls.length === 512
      ? (s.mode === 'saturated' ? [] : taint(s, at, true)) : taint(s, at)
    if (s.calls.length < 512) s.calls.push({ id, identity: 'unknown', kind: 'unknown',
      label: 'other', recognition: { kind: 'unknown', reason: 'ambiguous', label: 'other' },
      outcome: 'quarantined', denied: false })
    return { duplicate: false, eligible: false, first: false, closed }
  }
  if (call.outcome !== 'pending') return { duplicate: true, eligible: false, first: false, closed: [] }
  const classified = classifyToolResult({ failed, output, tool: call.recognition,
    trustedDenial: call.denied ? 'denied' : 'not-supplied' })
  call.outcome = classified.outcome
  const result: Result = { duplicate: false, eligible: true, call,
    first: s.firsts.some(first => first.identity === call.identity && first.callId === id),
    closed: [], ...(classified.outcome === 'failed' ? { failureClass: classified.failureClass } : {}) }
  if (s.mode !== 'observing' || call.identity === 'unknown') return result
  const index = s.streaks.findIndex(value => same(value, call))
  if (failed) {
    if (index >= 0) s.streaks[index]!.length++
    else s.streaks.push({ identity: call.identity, kind: call.kind, label: call.label,
      length: 1, firstCallId: id, firstAt: at })
  } else if (index >= 0) {
    result.closed.push({ ...s.streaks[index]!, resolution: 'recovered', closedAt: at })
    s.streaks.splice(index, 1)
  }
  return result
}
export function finishTools(s: ToolState, at: string, partial: boolean): { closed: ClosedStreak[]; coverage: Record<string, number | boolean> } {
  if (s.links.some(link => link.state === 'denied-await-call')) s.denialIncomplete = true
  const closed = partial ? taint(s, at) : closeStreaks(s, s.mode === 'observing' ? 'abandoned' : 'unknown', at)
  return { closed, coverage: { toolCoverageVersion: 1, toolFirstHistoryUnknown: s.firstHistoryUnknown,
    toolStreakTainted: s.mode !== 'observing', toolDenialIncomplete: s.denialIncomplete } }
}

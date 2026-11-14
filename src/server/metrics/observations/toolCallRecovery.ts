// Row-intrinsic recovery validation. Never consult not-yet-restored manager records.
import { BUILT_IN_TOOLS, PUBLIC_BUILT_IN_LABELS } from './toolCalls'
import type { ToolState } from './toolCallState'
import type { LiveTurn } from './chatTracker'

type Obj = Record<string, unknown>
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const string = (v: unknown): v is string => typeof v === 'string'
const time = (v: unknown) => string(v) && Number.isFinite(Date.parse(v))
const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max
const exact = (o: Obj, keys: string[]) => Object.keys(o).every(key => keys.includes(key))
const unique = (a: Obj[], key: string) => new Set(a.map(v => v[key])).size === a.length
function recognition(v: unknown, identity: unknown, kind: unknown): boolean {
  if (!object(v) || v.kind !== kind) return false
  if (kind === 'builtin') return exact(v, ['kind', 'name']) && string(v.name) && (BUILT_IN_TOOLS as readonly string[]).includes(v.name) && identity === v.name
  if (kind === 'team') return exact(v, ['kind', 'name']) && string(v.name) && v.name.length > 0 && v.name.length <= 128 && identity === v.name
  if (kind === 'foreign') return exact(v, ['kind', 'label']) && ['other', 'mcp:other'].includes(String(v.label)) &&
    (identity === 'unknown' || (string(identity) && /^slot-([1-9]|[1-8][0-9]|9[0-6])$/.test(identity)))
  return kind === 'unknown' && identity === 'unknown' && exact(v, ['kind', 'reason', 'label']) &&
    v.reason === 'ambiguous' && ['other', 'mcp:other'].includes(String(v.label))
}
export function validToolState(v: unknown): v is ToolState {
  if (!object(v) || !exact(v, ['version','calls','links','firsts','streaks','slots','mode','firstHistoryUnknown','denialIncomplete','seenRecorderFailures']) ||
    v.version !== 1 || !integer(v.slots, 96) || !integer(v.seenRecorderFailures) ||
    !['observing','tainted','saturated'].includes(String(v.mode)) ||
    typeof v.firstHistoryUnknown !== 'boolean' || typeof v.denialIncomplete !== 'boolean') return false
  if (!Array.isArray(v.calls) || v.calls.length > 512 || !Array.isArray(v.links) || v.links.length > 64 ||
    !Array.isArray(v.firsts) || v.firsts.length > 512 || !Array.isArray(v.streaks) || v.streaks.length > 512) return false
  const calls = v.calls
  if (!calls.every(c => object(c) && exact(c,['id','identity','kind','label','recognition','outcome','denied']) &&
    string(c.id) && string(c.label) && c.label.length <= 128 && typeof c.denied === 'boolean' &&
    ['pending','success','failed','quarantined'].includes(String(c.outcome)) && recognition(c.recognition,c.identity,c.kind)) ||
    !unique(calls,'id')) return false
  if (!calls.every(c => c.kind === 'builtin'
    ? c.label === ((PUBLIC_BUILT_IN_LABELS as readonly string[]).includes(String(c.identity)) ? c.identity : 'other')
    : c.kind === 'team' ? c.label === c.identity || c.label === 'other'
    : c.label === c.recognition.label)) return false
  if (!calls.every(c => c.kind !== 'foreign' || c.identity === 'unknown' ||
    Number(String(c.identity).slice(5)) <= Number(v.slots))) return false
  if (!v.links.every(q => object(q) && exact(q,['id','callId','state']) && string(q.id) &&
    (q.callId === null || string(q.callId)) &&
    ['pending','denied-await-call','transferred','allowed','cancelled','unlinked'].includes(String(q.state))) || !unique(v.links,'id')) return false
  if (!v.firsts.every(f => object(f) && exact(f,['identity','callId']) && string(f.identity) && string(f.callId) &&
    calls.some(c => c.kind === 'team' && c.identity === f.identity && c.id === f.callId)) || !unique(v.firsts,'identity')) return false
  if (!v.streaks.every(s => object(s) && exact(s,['identity','kind','label','length','firstCallId','firstAt']) &&
    integer(s.length,512) && Number(s.length)>0 && time(s.firstAt) && string(s.label) &&
    calls.some(c => c.id === s.firstCallId && c.identity === s.identity && c.kind === s.kind && c.label === s.label && c.identity !== 'unknown' && c.outcome === 'failed'))) return false
  if (v.mode !== 'observing' && (v.streaks.length || v.firstHistoryUnknown !== true)) return false
  if (new Set(v.streaks.map(s => JSON.stringify([s.kind,s.identity]))).size !== v.streaks.length) return false
  if (!v.streaks.every(s => s.length <= calls.filter(c => c.outcome === 'failed' && c.kind === s.kind && c.identity === s.identity).length)) return false
  return true
}
export function decodeLiveTurn(sessionId: string, raw: string): LiveTurn | null {
  let v: unknown
  try { v = JSON.parse(raw) } catch { return null }
  if (!object(v) || !exact(v,['scope','at','lastSeen','phase','tools','requests','waitSeconds','waitStarted','sequence','repinnable','phaseSeconds','unmatched','unmatchedCount','context','contextSource','tm'])) return null
  if (!object(v.scope) || v.scope.sessionId !== sessionId || !string(v.scope.turnId) ||
    !v.scope.turnId || !time(v.at) || !time(v.lastSeen) || !integer(v.sequence) ||
    typeof v.repinnable !== 'boolean' || typeof v.waitSeconds !== 'number' ||
    !Number.isFinite(v.waitSeconds) || v.waitSeconds < 0 || !(v.waitStarted === null || time(v.waitStarted))) return null
  const identity = ['teamId','taskId','assignmentId','resultId','sessionId','turnId','startId','groupId','profileId','providerId','model','accountRevision','actorSession','toolCallId','requestId']
  if (!exact(v.scope,[...identity,'taskRevision']) || !Object.entries(v.scope).every(([k,x]) =>
    x === null || (k === 'taskRevision' ? integer(x) : string(x)))) return null
  const segment = (x: unknown) => object(x) && exact(x,['at','category','waitBaseline']) && time(x.at) &&
    string(x.category) && (x.waitBaseline === undefined || (typeof x.waitBaseline === 'number' && Number.isFinite(x.waitBaseline) && x.waitBaseline >= 0))
  if (!(v.phase === null || segment(v.phase)) || !object(v.tools) || !object(v.requests) ||
    !Object.values(v.tools).every(x => segment(x) && ['shell','file','mcp','other'].includes(String((x as Obj).category))) || !Object.values(v.requests).every(x => segment(x) && ['approval','question'].includes(String((x as Obj).category)))) return null
  if (v.contextSource !== undefined && !string(v.contextSource)) return null
  if (v.phaseSeconds !== undefined && (!object(v.phaseSeconds) || !Object.values(v.phaseSeconds).every(x =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0))) return null
  if (v.unmatched !== undefined && (!Array.isArray(v.unmatched) || !v.unmatched.every(string))) return null
  if (v.unmatchedCount !== undefined && !integer(v.unmatchedCount)) return null
  if (v.tm !== undefined && !validToolState(v.tm)) return null
  // Context is existing structured usage, never a transcript/tool payload.
  if (v.context !== undefined && v.context !== null && (!object(v.context) || !Object.values(v.context).every(x =>
    x === null || typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))))) return null
  return v as unknown as LiveTurn
}

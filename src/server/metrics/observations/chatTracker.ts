// Managed-turn measurements (process-observability D3/D4): one live turn per
// chat session, folded from chat events and activity phases into turn,
// attribution, tool, request, context, compaction and settings facts. Phase
// time accumulates on the live turn and lands as per-phase totals on its
// `turn_ended` (compact-observation-detail D1); each tool call and request is
// one row written at completion or turn close (D2); a resolution with no open
// request is only counted (D3). The live state is saved after every step, so
// a restart closes each open turn as `process-ended` and records the restart
// gap. No transcript text, tool inputs or outputs are retained.
import type { ChatActivity, ChatContextUsage, ChatEvent } from '../../../shared/chat'
import { turnSucceeded } from '../../../shared/chat'
import type { Measurement, ObservationIdentity, ObservationKind } from '../../../shared/processObservations'
import { ObservationRecorder } from './recorder'
import { ToolCallTracker } from './toolCallTracker'
import { decodeLiveTurn } from './toolCallRecovery'
import type { ClosedStreak, ToolState } from './toolCallState'
import { TEAM_TOOL_PREFIX, type TeamCatalogue } from './toolCalls'
interface Segment {
  at: string
  category: string
  waitBaseline?: number
}
export interface LiveTurn {
  scope: ObservationIdentity
  at: string
  lastSeen: string
  phase: Segment | null
  tools: Record<string, Segment>
  requests: Record<string, Segment>
  waitSeconds: number
  waitStarted: string | null
  sequence: number
  repinnable: boolean
  /** Seconds per phase field; absent in turns persisted by an older build. */
  phaseSeconds?: Record<string, number>
  /** Request ids resolved with no open request, counted once each. */
  unmatched?: string[]
  unmatchedCount?: number
  tm?: ToolState
  context?: ChatContextUsage | null
  contextSource?: string
}
interface ContextReading {
  at: number
  threshold: number
  approximate: boolean
  source?: string
}
const SUPPORTED_EVENTS = [
  'turn_started',
  'peer_message',
  'turn_completed',
  'turn_interrupted',
  'tool_call',
  'tool_result',
  'approval_request',
  'question_request',
  'request_resolved',
]
const CONTEXT_SAMPLE_MS = 60000
const seconds = (a: string, b: string) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000)
/** `turn_ended` field per activity phase; an unknown phase lands in `otherPhaseSeconds`. */
const PHASE_FIELDS: Record<string, string> = {
  thinking: 'thinkingSeconds',
  requesting: 'requestingSeconds',
  preparing_tool: 'preparingToolSeconds',
  running_tools: 'runningToolsSeconds',
  responding: 'respondingSeconds',
  retrying: 'retryingSeconds',
}
const OTHER_PHASE_FIELD = 'otherPhaseSeconds'
function toolCategory(tool: string): string {
  if (tool === 'Bash' || tool === 'Monitor') return 'shell'
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') return 'file'
  if (tool.startsWith('mcp__')) return 'mcp'
  return 'other'
}
export class ChatObservationTracker {
  private readonly live = new Map<string, LiveTurn>()
  private readonly contexts = new Map<string, ChatContextUsage | null>()
  private readonly readings = new Map<string, ContextReading>()
  readonly blocked = new Set<string>()
  readonly pendingRecovery = new Set<string>()
  readonly quarantined = new Set<string>()
  private inventoried = false
  private readonly toolState: ToolCallTracker
  constructor(
    private readonly recorder: ObservationRecorder,
    private readonly identity: (id: string) => ObservationIdentity,
    catalogue: TeamCatalogue = { prefix: TEAM_TOOL_PREFIX, members: new Set() },
    private readonly inventoryRequired = false,
  ) { this.toolState = new ToolCallTracker(catalogue) }
  get inventoryReady(): boolean { return this.inventoried }
  private isBlocked(id: string): boolean { return this.blocked.has(id) || (this.inventoryRequired && !this.inventoried) }
  recover(): void {
    if (!this.inventoried) {
      const rows = this.recorder.store.db.prepare('SELECT session_id FROM process_live_observations').all() as { session_id: string }[]
      for (const row of rows) { this.blocked.add(row.session_id); this.pendingRecovery.add(row.session_id) }
      this.inventoried = true
    }
    this.retryRecovery()
  }
  retryRecovery(): void {
    for (const id of [...this.pendingRecovery]) {
      const row = this.recorder.store.db.prepare('SELECT state FROM process_live_observations WHERE session_id=?').get(id) as { state: string } | null
      if (!row) { this.pendingRecovery.delete(id); this.blocked.delete(id); continue }
      const turn = decodeLiveTurn(id, row.state)
      if (!turn) { this.quarantined.add(id); this.pendingRecovery.delete(id); continue }
      const committed = this.atomic(() => {
        this.live.set(id, turn)
        this.finish(id, 'process-ended', turn.lastSeen, true)
        const until = new Date(this.recorder.store.now()).toISOString()
        this.recorder.store.record({ ...turn.scope, sourceKey: 'restart-gap:' + id + ':' + turn.scope.turnId,
          kind: 'gap', observedAt: until, data: { since: turn.lastSeen, until, source: 'managed-turn' } })
      })
      if (committed) { this.pendingRecovery.delete(id); this.blocked.delete(id) }
    }
  }
  event(sessionId: string, event: ChatEvent): void {
    if (this.isBlocked(sessionId)) return
    if (!SUPPORTED_EVENTS.includes(event.type) || !Number.isFinite(Date.parse(event.at))) return
    this.atomic(() => {
      const key = `chat:${sessionId}:${event.id}`
      const db = this.recorder.store.db
      if (db.prepare('SELECT 1 FROM process_observations WHERE source_key=?').get(key)) return
      const at = event.at
      if (event.type === 'turn_started') {
        if (this.live.get(sessionId)?.scope.turnId === event.turnId) return
        if (db.prepare("SELECT 1 FROM process_observations WHERE kind='turn_ended' AND session_id=? AND turn_id=?").get(sessionId,event.turnId)) return
        if (this.live.has(sessionId)) this.finish(sessionId, 'process-ended', at, true)
        const scope = { ...this.identity(sessionId), sessionId, turnId: event.turnId }
        this.live.set(sessionId, {
          scope,
          at,
          lastSeen: at,
          phase: null,
          tools: {},
          requests: {},
          waitSeconds: 0,
          waitStarted: null,
          sequence: 0,
          repinnable: true,
          phaseSeconds: {},
          unmatched: [],
        })
        this.toolState.start(this.live.get(sessionId)!, this.recorder.failures)
        this.write(this.live.get(sessionId)!, key, 'turn_started', at, {})
        this.sampleContext(sessionId, this.contexts.get(sessionId) ?? null, true)
      }
      const turn = this.live.get(sessionId)
      if (!turn) return
      if ('turnId' in event && event.turnId !== turn.scope.turnId) return
      const watched=this.toolState.watch(turn, this.recorder.failures, at, facts => this.writeStreaks(turn, facts))
      turn.lastSeen = at
      if (watched) this.save(sessionId,turn)
      if (event.type === 'peer_message' && turn.repinnable) {
        turn.scope.taskId = event.task?.id ?? null
        turn.scope.taskRevision = event.task?.revision ?? null
        const assignment = db
          .prepare('SELECT id,result_id FROM team_task_assignments WHERE message_id=?')
          .get(event.messageId) as { id: string; result_id: string | null } | null
        turn.scope.assignmentId = assignment?.id ?? null
        turn.scope.resultId = assignment?.result_id ?? null
        turn.repinnable = false
        this.write(turn, key, 'turn_attribution', at, {})
      } else if (event.type === 'turn_completed' || event.type === 'turn_interrupted') {
        this.sampleContext(sessionId, turn.context ?? null, true)
        const outcome =
          event.type === 'turn_interrupted' ? 'interrupted' : turnSucceeded(event) ? 'success' : 'failed'
        const usageAvailable = event.type === 'turn_completed' && event.usage !== undefined
        this.finish(sessionId, outcome, at, false, key, usageAvailable)
        return
      } else if (event.type === 'tool_call') {
        if (!this.toolState.call(turn,event,facts => this.writeStreaks(turn,facts))) return
        turn.repinnable = false
        if (!Object.hasOwn(turn.tools,event.toolCallId)) Object.defineProperty(turn.tools,event.toolCallId,{ configurable:true,enumerable:true,writable:true,value: {
          at,
          category: toolCategory(event.tool),
          waitBaseline: this.waitTime(turn, at),
        } })
      } else if (event.type === 'tool_result') {
        const fields = this.toolState.result(turn,event,facts => this.writeStreaks(turn,facts))
        if (!fields) return
        const tool = Object.hasOwn(turn.tools,event.toolCallId) ? turn.tools[event.toolCallId] : undefined
        this.write(
          turn,
          key,
          'tool',
          at,
          {
            ...fields,
            category: tool?.category ?? 'other',
            startedAt: tool?.at ?? null,
            durationSeconds: tool ? this.toolSeconds(turn, tool, at) : null,
            outcome: event.isError ? 'failed' : 'success',
            partial: !tool,
          },
          { toolCallId: event.toolCallId },
        )
        delete turn.tools[event.toolCallId]
      } else if (event.type === 'approval_request' || event.type === 'question_request') {
        if (turn.unmatched?.includes(event.requestId)) return
        if (event.type === 'approval_request') this.toolState.request(turn,event)
        this.closePhase(turn, at)
        turn.repinnable = false
        if (Object.keys(turn.requests).length === 0) turn.waitStarted = at
        const category = event.type === 'approval_request' ? 'approval' : 'question'
        if (!Object.hasOwn(turn.requests,event.requestId)) Object.defineProperty(turn.requests,event.requestId,{configurable:true,enumerable:true,writable:true,value:{at,category}})
      } else if (event.type === 'request_resolved') {
        if (turn.unmatched?.includes(event.requestId)) return
        const request = Object.hasOwn(turn.requests,event.requestId) ? turn.requests[event.requestId] : undefined
        if (request?.category !== 'question') this.toolState.resolve(turn,event.requestId,event.outcome)
        turn.unmatchedCount ??= turn.unmatched?.length ?? 0
        turn.unmatched ??= []
        turn.unmatched.push(event.requestId)
        if (request) {
          this.write(
            turn,
            key,
            'request',
            at,
            {
              requestKind: request.category,
              startedAt: request.at,
              durationSeconds: seconds(request.at, at),
              outcome: event.outcome,
              partial: false,
            },
            { requestId: event.requestId },
          )
        } else {
          // No row carries this event's key, so a redelivery is recognized by its request id.
          turn.unmatchedCount++
        }
        delete turn.requests[event.requestId]
        if (Object.keys(turn.requests).length === 0 && turn.waitStarted) {
          turn.waitSeconds += seconds(turn.waitStarted, at)
          turn.waitStarted = null
        }
        // Wait duration is never charged to the resumed model/tool phase.
        turn.phase = null
      }
      this.save(sessionId, turn)
    })
  }
  activity(sessionId: string, activity: ChatActivity | null): void {
    if (this.isBlocked(sessionId)) return
    this.atomic(() => {
      const turn = this.live.get(sessionId)
      if (!turn) return
      const at = new Date(this.recorder.store.now()).toISOString()
      this.closePhase(turn, at)
      if (activity && Object.keys(turn.requests).length === 0) turn.phase = { at, category: activity.phase }
      turn.lastSeen = at
      this.save(sessionId, turn)
    })
  }
  context(sessionId: string, usage: ChatContextUsage | null, force = false, source?: string): void {
    if (this.isBlocked(sessionId)) return
    this.atomic(() => this.sampleContext(sessionId, usage, force, source))
  }
  compaction(sessionId: string, data: Measurement, sourceId?: string): void {
    if (this.isBlocked(sessionId)) return
    this.atomic(() => {
      const sourceKey = `compaction:${sessionId}:${sourceId ?? crypto.randomUUID()}`
      const known = this.recorder.store.db
        .prepare('SELECT 1 FROM process_observations WHERE source_key=?')
        .get(sourceKey)
      if (known) return
      this.sampleContext(sessionId, this.live.get(sessionId)?.context ?? null, true)
      this.recorder.store.record({
        ...(this.live.get(sessionId)?.scope ?? this.identity(sessionId)),
        sessionId,
        kind: 'compaction',
        sourceKey,
        observedAt: new Date(this.recorder.store.now()).toISOString(),
        data,
      })
    })
  }
  settings(sessionId: string, data: Measurement): void {
    if (this.isBlocked(sessionId)) return
    this.recorder.record({
      ...this.identity(sessionId),
      sessionId,
      kind: 'settings',
      sourceKey: `settings:${sessionId}:${crypto.randomUUID()}`,
      observedAt: new Date(this.recorder.store.now()).toISOString(),
      data,
    })
  }
  processEnded(sessionId: string): void {
    this.atomic(() =>
      this.finish(sessionId, 'process-ended', new Date(this.recorder.store.now()).toISOString(), true),
    )
    this.readings.delete(sessionId)
    this.contexts.delete(sessionId)
  }
  checkpoint(): void {
    for (const id of [...this.live.keys()]) {
      if (this.blocked.has(id)) continue
      this.atomic(() => {
        const turn = this.live.get(id)!
        const at = new Date(this.recorder.store.now()).toISOString()
        this.toolState.watch(turn,this.recorder.failures,at,facts => this.writeStreaks(turn,facts))
        turn.lastSeen = at
        this.save(id,turn)
      })
    }
  }
  /** Samples at most once a minute, except at turn boundaries and threshold changes. */
  private sampleContext(sessionId: string, usage: ChatContextUsage | null, force: boolean, source?: string): void {
    const turn = this.live.get(sessionId)
    this.contexts.set(sessionId, usage)
    source ??= turn?.contextSource
    if (turn) {
      turn.context = usage
      turn.contextSource = source
    }
    if (!usage) return
    const prev = this.readings.get(sessionId)
    const now = this.recorder.store.now()
    const approximate = usage.thresholdApproximate === true
    const changed =
      prev?.threshold !== usage.thresholdTokens || prev?.approximate !== approximate || prev?.source !== source
    const boundary = force || changed
    if (!boundary && prev && now - prev.at < CONTEXT_SAMPLE_MS) return
    if (changed) {
      this.recorder.store.record({
        ...(turn?.scope ?? this.identity(sessionId)),
        sessionId,
        kind: 'settings',
        sourceKey: `settings:${sessionId}:${crypto.randomUUID()}`,
        observedAt: usage.at,
        data: {
          thresholdSource: source ?? (approximate ? 'window-fallback' : 'observed-threshold'),
          contextWindow: approximate ? usage.thresholdTokens : null,
        },
      })
    }
    this.readings.set(sessionId, { at: now, threshold: usage.thresholdTokens, approximate, source })
    const scope = turn?.scope ?? { ...this.identity(sessionId), sessionId }
    this.recorder.store.record({
      ...scope,
      kind: 'context',
      sourceKey: `context:${sessionId}:${crypto.randomUUID()}`,
      observedAt: usage.at,
      data: {
        usedTokens: usage.usedTokens,
        thresholdTokens: usage.thresholdTokens,
        approximate,
        boundary,
        thresholdSource: source ?? null,
      },
    })
    if (turn) {
      turn.lastSeen = new Date(now).toISOString()
      this.save(sessionId, turn)
    }
  }
  private waitTime(turn: LiveTurn, at: string): number {
    return (turn.waitSeconds ?? 0) + (turn.waitStarted ? seconds(turn.waitStarted, at) : 0)
  }
  private toolSeconds(turn: LiveTurn, tool: Segment, at: string): number {
    return Math.max(0, seconds(tool.at, at) - (this.waitTime(turn, at) - (tool.waitBaseline ?? 0)))
  }
  /** One transaction; the in-memory maps roll back with it. */
  private atomic(work: () => void): boolean {
    let committed = false
    this.recorder.safe(() => {
      const before = structuredClone(this.live)
      const readings = structuredClone(this.readings)
      const contexts = structuredClone(this.contexts)
      const names = structuredClone(this.toolState.names)
      try {
        this.recorder.store.db.transaction(work)()
        committed = true
      } catch (error) {
        this.live.clear()
        for (const [id, value] of before) this.live.set(id, value)
        this.readings.clear()
        for (const [id, value] of readings) this.readings.set(id, value)
        this.toolState.names.clear()
        for (const [id, value] of names) this.toolState.names.set(id,value)
        this.contexts.clear()
        for (const [id, value] of contexts) this.contexts.set(id, value)
        throw error
      }
    })
    return committed
  }
  private finish(
    id: string,
    outcome: string,
    at: string,
    partial: boolean,
    key?: string,
    usageAvailable = false,
  ): void {
    const turn = this.live.get(id)
    if (!turn) return
    this.toolState.watch(turn,this.recorder.failures,at,facts => this.writeStreaks(turn,facts))
    const coverage = this.toolState.finish(turn,at,partial,facts => this.writeStreaks(turn,facts))
    this.closePhase(turn, at)
    for (const [toolCallId, tool] of Object.entries(turn.tools)) {
      this.write(
        turn,
        this.edgeKey(turn),
        'tool',
        at,
        {
          category: tool.category,
          startedAt: tool.at,
          durationSeconds: this.toolSeconds(turn, tool, at),
          outcome: 'unavailable',
          partial: true,
        },
        { toolCallId },
      )
    }
    for (const [requestId, request] of Object.entries(turn.requests)) {
      this.write(
        turn,
        this.edgeKey(turn),
        'request',
        at,
        {
          requestKind: request.category,
          startedAt: request.at,
          durationSeconds: seconds(request.at, at),
          outcome: 'unavailable',
          partial: true,
        },
        { requestId },
      )
    }
    this.write(turn, key ?? `turn-end:${id}:${turn.scope.turnId}`, 'turn_ended', at, {
      outcome,
      durationSeconds: seconds(turn.at, at),
      partial,
      usageAvailable,
      ...this.phaseTotals(turn),
      unmatchedResolutions: turn.unmatchedCount ?? turn.unmatched?.length ?? 0,
      ...coverage,
    })
    this.live.delete(id)
    this.recorder.store.db.prepare('DELETE FROM process_live_observations WHERE session_id=?').run(id)
  }
  private closePhase(turn: LiveTurn, at: string): void {
    if (turn.phase) {
      const field = Object.hasOwn(PHASE_FIELDS,turn.phase.category) ? PHASE_FIELDS[turn.phase.category]! : OTHER_PHASE_FIELD
      turn.phaseSeconds ??= {}
      turn.phaseSeconds[field] = (turn.phaseSeconds[field] ?? 0) + seconds(turn.phase.at, at)
    }
    turn.phase = null
  }
  /** Every phase field, zero when the turn never entered it. */
  private phaseTotals(turn: LiveTurn): Measurement {
    const fields = [...Object.values(PHASE_FIELDS), OTHER_PHASE_FIELD]
    return Object.fromEntries(fields.map(field => [field, turn.phaseSeconds?.[field] ?? 0]))
  }
  /** Keys the partial row of a call or request still open at turn close. */
  private edgeKey(turn: LiveTurn): string {
    return `segment:${turn.scope.sessionId}:${turn.scope.turnId}:${++turn.sequence}`
  }
  private write(
    turn: LiveTurn,
    sourceKey: string,
    kind: ObservationKind,
    observedAt: string,
    data: Measurement,
    identity: ObservationIdentity = {},
  ): void {
    this.recorder.store.record({ ...turn.scope, ...identity, sourceKey, kind, observedAt, data })
  }
  private writeStreaks(turn: LiveTurn, facts: ClosedStreak[]): void {
    for (const fact of facts) this.write(turn,this.edgeKey(turn),'tool_streak',fact.closedAt,{
      tool: fact.identity, toolKind: fact.kind, label: fact.label, length: fact.length,
      resolution: fact.resolution, firstAt: fact.firstAt, closedAt: fact.closedAt,
    }, { toolCallId: fact.firstCallId })
  }
  private save(id: string, turn: LiveTurn): void {
    this.recorder.store.db
      .prepare(
        'INSERT INTO process_live_observations VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state',
      )
      .run(id, JSON.stringify(turn))
  }
}

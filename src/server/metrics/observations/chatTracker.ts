// Managed-turn measurements. No transcript text, tool inputs or outputs are retained.
import type { ChatEvent, ChatActivity, ChatContextUsage } from '../../../shared/chat';
import { turnSucceeded } from '../../../shared/chat';
import type { ObservationIdentity, ObservationKind, Measurement } from '../../../shared/processObservations';
import { ObservationRecorder } from './recorder';
interface Segment {
  at: string;
  category: string;
  waitBaseline?: number;
}
interface LiveTurn {
  scope: ObservationIdentity;
  at: string;
  lastSeen: string;
  phase: Segment | null;
  tools: Record<string, Segment>;
  requests: Record<string, Segment>;
  waitSeconds: number;
  waitStarted: string | null;
  sequence: number;
  repinnable: boolean;
  context?: ChatContextUsage | null;
  contextSource?: string;
}
const seconds = (a: string, b: string) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000);
const toolCategory = (tool: string) => tool === 'Bash' || tool === 'Monitor' ? 'shell' : tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' ? 'file' : tool.startsWith('mcp__') ? 'mcp' : 'other';
export class ChatObservationTracker {
  private readonly live = new Map<string, LiveTurn>();
  private readonly contexts = new Map<string, ChatContextUsage | null>();
  private readonly readings = new Map<string, {
    at: number;
    threshold: number;
    approximate: boolean;
    source?: string;
  }>();
  constructor(private readonly recorder: ObservationRecorder, private readonly identity: (id: string) => ObservationIdentity) { }
  recover(): void {
    this.atomic(() => {
      const rows = this.recorder.store.db.prepare('SELECT session_id,state FROM process_live_observations').all() as {
        session_id: string;
        state: string;
      }[];
      for (const row of rows) {
        const turn = JSON.parse(row.state) as LiveTurn;
        this.live.set(row.session_id, turn);
        this.finish(row.session_id, 'process-ended', turn.lastSeen, true);
        const until = new Date(this.recorder.store.now()).toISOString();
        this.recorder.store.record({ ...turn.scope, sourceKey: `restart-gap:${row.session_id}:${turn.scope.turnId}`, kind: 'gap', observedAt: until, data: { since: turn.lastSeen, until, source: 'managed-turn' } });
      }
    });
  }
  event(sessionId: string, event: ChatEvent): void {
    const supported = ['turn_started', 'peer_message', 'turn_completed', 'turn_interrupted', 'tool_call', 'tool_result', 'approval_request', 'question_request', 'request_resolved'];
    if (!supported.includes(event.type) || !Number.isFinite(Date.parse(event.at)))
      return;
    this.atomic(() => {
      const key = `chat:${sessionId}:${event.id}`;
      const db = this.recorder.store.db;
      if (db.prepare('SELECT 1 FROM process_observation_keys WHERE source_key=?').get(key))
        return;
      const at = event.at;
      if (event.type === 'turn_started') {
        if (this.live.has(sessionId))
          this.finish(sessionId, 'process-ended', at, true);
        const scope = { ...this.identity(sessionId), sessionId, turnId: event.turnId };
        this.live.set(sessionId, { scope, at, lastSeen: at, phase: null, tools: {}, requests: {}, waitSeconds: 0, waitStarted: null, sequence: 0, repinnable: true });
        this.write(this.live.get(sessionId)!, key, 'turn_started', at, {});
        this.sampleContext(sessionId, this.contexts.get(sessionId) ?? null, true);
      }
      const turn = this.live.get(sessionId);
      if (!turn)
        return;
      if ('turnId' in event && event.turnId !== turn.scope.turnId)
        return;
      turn.lastSeen = at;
      if (event.type === 'peer_message' && turn.repinnable) {
        turn.scope.taskId = event.task?.id ?? null;
        turn.scope.taskRevision = event.task?.revision ?? null;
        const assignment = this.recorder.store.db.prepare('SELECT id,result_id FROM team_task_assignments WHERE message_id=?').get(event.messageId) as {
          id: string;
          result_id: string | null;
        } | null;
        turn.scope.assignmentId = assignment?.id ?? null;
        turn.scope.resultId = assignment?.result_id ?? null;
        turn.repinnable = false;
        this.write(turn, key, 'turn_attribution', at, {});
      }
      else if (event.type === 'turn_completed' || event.type === 'turn_interrupted') {
        this.sampleContext(sessionId, turn.context ?? null, true);
        this.finish(sessionId, event.type === 'turn_interrupted' ? 'interrupted' : turnSucceeded(event) ? 'success' : 'failed', at, false, key, event.type === 'turn_completed' && event.usage !== undefined);
        return;
      }
      else if (event.type === 'tool_call') {
        turn.repinnable = false;
        turn.tools[event.toolCallId] ??= { at, category: toolCategory(event.tool), waitBaseline: this.waitTime(turn, at) };
        this.write(turn, key, 'tool', at, { category: toolCategory(event.tool), startedAt: at, durationSeconds: null, partial: false }, { toolCallId: event.toolCallId });
      }
      else if (event.type === 'tool_result') {
        const tool = turn.tools[event.toolCallId];
        this.write(turn, key, 'tool', at, { category: tool?.category ?? 'other', startedAt: tool?.at ?? null, durationSeconds: tool ? this.toolSeconds(turn, tool, at) : null, outcome: event.isError ? 'failed' : 'success', partial: !tool }, { toolCallId: event.toolCallId });
        delete turn.tools[event.toolCallId];
      }
      else if (event.type === 'approval_request' || event.type === 'question_request') {
        this.closePhase(turn, at);
        turn.repinnable = false;
        if (Object.keys(turn.requests).length === 0)
          turn.waitStarted = at;
        turn.requests[event.requestId] = { at, category: event.type === 'approval_request' ? 'approval' : 'question' };
        this.write(turn, key, 'request', at, { requestKind: turn.requests[event.requestId]!.category, startedAt: at, durationSeconds: null }, { requestId: event.requestId });
      }
      else if (event.type === 'request_resolved') {
        const request = turn.requests[event.requestId];
        this.write(turn, key, 'request', at, { requestKind: request?.category ?? 'unknown', startedAt: request?.at ?? null, durationSeconds: request ? seconds(request.at, at) : null, outcome: event.outcome, partial: !request }, { requestId: event.requestId });
        delete turn.requests[event.requestId];
        if (Object.keys(turn.requests).length === 0 && turn.waitStarted) {
          turn.waitSeconds += seconds(turn.waitStarted, at);
          turn.waitStarted = null;
        }
        // Wait duration is never charged to the resumed model/tool phase.
        turn.phase = null;
      }
      this.save(sessionId, turn);
    });
  }
  activity(sessionId: string, activity: ChatActivity | null): void {
    this.atomic(() => {
      const turn = this.live.get(sessionId);
      if (!turn)
        return;
      const at = new Date(this.recorder.store.now()).toISOString();
      this.closePhase(turn, at);
      if (activity && Object.keys(turn.requests).length === 0)
        turn.phase = { at, category: activity.phase };
      turn.lastSeen = at;
      this.save(sessionId, turn);
    });
  }
  context(sessionId: string, usage: ChatContextUsage | null, force = false, source?: string): void {
    this.atomic(() => this.sampleContext(sessionId, usage, force, source));
  }
  private sampleContext(sessionId: string, usage: ChatContextUsage | null, force: boolean, source?: string): void {
    const turn = this.live.get(sessionId);
    this.contexts.set(sessionId, usage);
    source ??= turn?.contextSource;
    if (turn) {
      turn.context = usage;
      turn.contextSource = source;
    }
    if (!usage)
      return;
    const prev = this.readings.get(sessionId), now = this.recorder.store.now(), approximate = usage.thresholdApproximate === true;
    const changed = prev?.threshold !== usage.thresholdTokens || prev?.approximate !== approximate || prev?.source !== source;
    const boundary = force || changed;
    if (!boundary && prev && now - prev.at < 60000)
      return;
    if (changed)
      this.recorder.store.record({ ...turn?.scope ?? this.identity(sessionId), sessionId, kind: 'settings', sourceKey: `settings:${sessionId}:${crypto.randomUUID()}`, observedAt: usage.at, data: { thresholdSource: source ?? (approximate ? 'window-fallback' : 'observed-threshold'), contextWindow: approximate ? usage.thresholdTokens : null } });
    this.readings.set(sessionId, { at: now, threshold: usage.thresholdTokens, approximate, source });
    const scope = turn?.scope ?? { ...this.identity(sessionId), sessionId };
    this.recorder.store.record({ ...scope, kind: 'context', sourceKey: `context:${sessionId}:${crypto.randomUUID()}`, observedAt: usage.at, data: { usedTokens: usage.usedTokens, thresholdTokens: usage.thresholdTokens, approximate, boundary, thresholdSource: source ?? null } });
    if (turn) {
      turn.lastSeen = new Date(now).toISOString();
      this.save(sessionId, turn);
    }
  }
  compaction(sessionId: string, data: Measurement, sourceId?: string): void {
    this.atomic(() => {
      const sourceKey = `compaction:${sessionId}:${sourceId ?? crypto.randomUUID()}`;
      if (this.recorder.store.db.prepare('SELECT 1 FROM process_observation_keys WHERE source_key=?').get(sourceKey))
        return;
      this.sampleContext(sessionId, this.live.get(sessionId)?.context ?? null, true);
      this.recorder.store.record({ ...this.live.get(sessionId)?.scope ?? this.identity(sessionId), sessionId, kind: 'compaction', sourceKey, observedAt: new Date(this.recorder.store.now()).toISOString(), data });
    });
  }
  settings(sessionId: string, data: Measurement): void {
    this.recorder.record({ ...this.identity(sessionId), sessionId, kind: 'settings', sourceKey: `settings:${sessionId}:${crypto.randomUUID()}`, observedAt: new Date(this.recorder.store.now()).toISOString(), data });
  }
  processEnded(sessionId: string): void {
    this.atomic(() => this.finish(sessionId, 'process-ended', new Date(this.recorder.store.now()).toISOString(), true));
    this.readings.delete(sessionId);
    this.contexts.delete(sessionId);
  }
  checkpoint(): void {
    this.recorder.safe(() => {
      const at = new Date(this.recorder.store.now()).toISOString();
      for (const [id, turn] of this.live) {
        turn.lastSeen = at;
        this.save(id, turn);
      }
    });
  }
  private waitTime(turn: LiveTurn, at: string): number {
    return (turn.waitSeconds ?? 0) + (turn.waitStarted ? seconds(turn.waitStarted, at) : 0);
  }
  private toolSeconds(turn: LiveTurn, tool: Segment, at: string): number {
    return Math.max(0, seconds(tool.at, at) - (this.waitTime(turn, at) - (tool.waitBaseline ?? 0)));
  }
  private atomic(work: () => void): void {
    this.recorder.safe(() => {
      const before = structuredClone(this.live);
      const readings = structuredClone(this.readings);
      const contexts = structuredClone(this.contexts);
      try {
        this.recorder.store.db.transaction(work)();
      }
      catch (error) {
        this.live.clear();
        for (const [id, value] of before)
          this.live.set(id, value);
        this.readings.clear();
        for (const [id, value] of readings)
          this.readings.set(id, value);
        this.contexts.clear();
        for (const [id, value] of contexts)
          this.contexts.set(id, value);
        throw error;
      }
    });
  }
  private finish(id: string, outcome: string, at: string, partial: boolean, key?: string, usageAvailable = false): void {
    const turn = this.live.get(id);
    if (!turn)
      return;
    this.closePhase(turn, at, partial);
    for (const [toolCallId, tool] of Object.entries(turn.tools))
      this.write(turn, this.edgeKey(turn), 'tool', at, { category: tool.category, startedAt: tool.at, durationSeconds: this.toolSeconds(turn, tool, at), outcome: 'unavailable', partial: true }, { toolCallId });
    for (const [requestId, request] of Object.entries(turn.requests))
      this.write(turn, this.edgeKey(turn), 'request', at, { requestKind: request.category, startedAt: request.at, durationSeconds: seconds(request.at, at), outcome: 'unavailable', partial: true }, { requestId });
    this.write(turn, key ?? `turn-end:${id}:${turn.scope.turnId}`, 'turn_ended', at, { outcome, durationSeconds: seconds(turn.at, at), partial, usageAvailable });
    this.live.delete(id);
    this.recorder.store.db.prepare('DELETE FROM process_live_observations WHERE session_id=?').run(id);
  }
  private closePhase(turn: LiveTurn, at: string, partial = false): void {
    if (turn.phase)
      this.write(turn, this.edgeKey(turn), 'activity', at, { phase: turn.phase.category, startedAt: turn.phase.at, durationSeconds: seconds(turn.phase.at, at), partial });
    turn.phase = null;
  }
  private edgeKey(turn: LiveTurn): string { return `segment:${turn.scope.sessionId}:${turn.scope.turnId}:${++turn.sequence}`; }
  private write(turn: LiveTurn, sourceKey: string, kind: ObservationKind, observedAt: string, data: Measurement, identity: ObservationIdentity = {}): void {
    this.recorder.store.record({ ...turn.scope, ...identity, sourceKey, kind, observedAt, data });
  }
  private save(id: string, turn: LiveTurn): void {
    this.recorder.store.db.prepare('INSERT INTO process_live_observations VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state').run(id, JSON.stringify(turn));
  }
}

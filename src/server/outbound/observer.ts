// The outbound observer (execution-safety-recovery D3, D5, D7): what the
// driver's four audit hooks hand each audited tool use to. Its synchronous
// part is pure parsing — a send candidate lands in the in-memory
// `pendingSends` map before the Pre hook returns, so an outcome that beats
// the deferred call row is never dropped — and every later step (facts
// walk, judging, redaction, database write) is deferred with `setImmediate`
// behind a catch-all, so it never runs on the hook path or delays the SDK's
// own continuation, and an uncaught throw never exits Bun. Purely
// observational: nothing here blocks or denies a tool call, and an observer
// failure never fails the call. Team mail (`mcp__kawai-team__*`) is never
// recorded — the mailbox already is.
import {
  CLASSIFIER_VERSION,
  judge,
  mcpCallCandidate,
  strongest,
  type JudgedCandidate,
  type SendCandidate,
} from './classify'
import type { DestinationClasses } from './classify'
import { parseSends } from './rules'
import { redact, redactForStore } from './redact'
import type { ResolvedRepoFacts } from './repoFacts'
import type { OutboundCallInsert, OutboundOutcomeInsert } from './store'

/** What the driver's audit hooks report, one method per SDK event (D3). */
export interface OutboundAuditSink {
  onPreToolUse(use: { toolName: string; toolInput: unknown; toolUseId: string; spawnId: string; agentId?: string; cwd: string }): void
  onPostToolUse(use: { toolName: string; toolInput: unknown; toolUseId: string; spawnId: string; agentId?: string; cwd: string; background: boolean; durationMs?: number }): void
  onPostToolUseFailure(use: { toolName: string; toolUseId: string; spawnId: string; agentId?: string; cwd: string; error: string; isInterrupt?: boolean; durationMs?: number }): void
  onPermissionDenied(use: { toolName: string; toolUseId: string; spawnId: string; agentId?: string; cwd: string; reason: string }): void
  /** The driver's own canUseTool deny path: a declined card or a cancelled ask. */
  onDeniedCard(use: { toolName: string; toolInput: unknown; toolUseId: string; spawnId: string; agentId?: string; cwd: string; reason?: string }): void
  /** An agent process ended: its calls read outcome-unknown unless settled (D7). */
  onSpawnEnd(spawnId: string): void
}

interface PendingSend {
  spawnId: string
  tool: string
  mcpServer?: string
  agentId?: string
  cwd: string
  /** The raw command text (or the MCP call summary), redacted only at write. */
  command: string
  candidates: SendCandidate[]
}

/** How much of an error or reason is read at all before redacting it. */
const DETAIL_READ_CAP = 2048
/** What an outcome's stored detail is clipped to after redaction. */
const DETAIL_STORE_CAP = 1024

export interface OutboundObserverOptions {
  sessionId: string
  store: { insertCall(row: OutboundCallInsert): void; insertOutcome(row: OutboundOutcomeInsert): void }
  destinations: DestinationClasses
  repos: { factsFor(cwd: string): ResolvedRepoFacts | null }
  /** The session's group, profile, and task when the call is made. */
  context: () => { groupId?: string; profileId?: string; taskId?: string }
  /** team_id for calls whose cwd sits in no repository (D6 names the cwd's team). */
  teamIdFallback: () => string
  now?: () => string
  id?: () => string
}

export class OutboundObserver implements OutboundAuditSink {
  /** Filled synchronously by Pre, before any outcome hook can fire (D3). */
  private readonly pendingSends = new Map<string, PendingSend>()
  /** Spawn ids the observer has seen live; a call with no outcome reads pending while its spawn lives (D7). */
  private readonly liveSpawns = new Set<string>()
  /** Bound once: a detached `crypto.randomUUID` reference throws in Bun. */
  private readonly newId: () => string

  constructor(private readonly options: OutboundObserverOptions) {
    this.newId = options.id ?? (() => crypto.randomUUID())
  }

  spawnIsLive(spawnId: string): boolean {
    return this.liveSpawns.has(spawnId)
  }

  /** Run after the current continuation and every microtask, never failing the process. */
  private defer(work: () => void): void {
    setImmediate(() => {
      try {
        work()
      } catch {
        // A failed write is a lost audit row, never a failed tool call.
      }
    })
  }

  onPreToolUse(use: Parameters<OutboundAuditSink['onPreToolUse']>[0]): void {
    if (use.toolName.startsWith('mcp__kawai-team__')) return
    if (this.pendingSends.has(use.toolUseId)) return
    const candidates = this.candidatesOf(use.toolName, use.toolInput, use.cwd)
    if (candidates.length === 0) return
    const mcp = use.toolName.startsWith('mcp__') ? use.toolName.split('__')[1] : undefined
    this.pendingSends.set(use.toolUseId, {
      spawnId: use.spawnId,
      tool: use.toolName,
      ...(mcp === undefined ? {} : { mcpServer: mcp }),
      ...(use.agentId === undefined ? {} : { agentId: use.agentId }),
      cwd: use.cwd,
      command: this.commandText(use.toolName, use.toolInput),
      candidates,
    })
    this.liveSpawns.add(use.spawnId)
    const entry = this.pendingSends.get(use.toolUseId)!
    this.defer(() => this.writeCall(use.toolUseId, entry))
  }

  onPostToolUse(use: Parameters<OutboundAuditSink['onPostToolUse']>[0]): void {
    // A background call is not terminal: its later fate shows in the roster.
    this.outcome(use.toolUseId, use.background ? 'started-background' : 'completed', use.durationMs)
  }

  onPostToolUseFailure(use: Parameters<OutboundAuditSink['onPostToolUseFailure']>[0]): void {
    // The pending lookup runs before any redaction: an unknown tool use
    // costs one map read, and the error text is capped before it is read.
    this.outcome(use.toolUseId, 'failed', use.durationMs, () => {
      // The interrupt marker leads, so the store cap can never cut it off.
      const text = redact(use.error.slice(0, DETAIL_READ_CAP))
      const cut = (use.isInterrupt === true ? `(interrupt) ${text}` : text).slice(0, DETAIL_STORE_CAP)
      // Redaction shrinks text, so the cut can slide unredacted tail under
      // the window; a second pass over the stored slice collapses it.
      return redact(cut).slice(0, DETAIL_STORE_CAP)
    })
  }

  onPermissionDenied(use: Parameters<OutboundAuditSink['onPermissionDenied']>[0]): void {
    this.outcome(use.toolUseId, 'denied', undefined, () => redact(redact(use.reason.slice(0, DETAIL_READ_CAP)).slice(0, DETAIL_STORE_CAP)).slice(0, DETAIL_STORE_CAP))
  }

  onDeniedCard(use: Parameters<OutboundAuditSink['onDeniedCard']>[0]): void {
    const reason = use.reason
    this.outcome(use.toolUseId, 'denied', undefined, reason === undefined ? undefined : () =>
      redact(reason.slice(0, DETAIL_READ_CAP)).slice(0, DETAIL_STORE_CAP))
  }

  onSpawnEnd(spawnId: string): void {
    this.liveSpawns.delete(spawnId)
    for (const [toolUseId, entry] of this.pendingSends) {
      if (entry.spawnId === spawnId) this.pendingSends.delete(toolUseId)
    }
  }

  /** Candidates for one tool use: parsed shell command, or one external MCP call (D5). */
  /** How much of a command the synchronous parse reads (the rest is a
   *  documented limitation: a 77 KB command would otherwise block the turn). */
  private static readonly PARSE_READ_MAX = 16_384

  private candidatesOf(toolName: string, toolInput: unknown, cwd: string): SendCandidate[] {
    if (toolName === 'Bash' || toolName === 'Monitor') {
      const command = (toolInput as { command?: unknown } | null)?.command
      return typeof command === 'string' ? parseSends(command.slice(0, OutboundObserver.PARSE_READ_MAX), cwd) : []
    }
    if (toolName.startsWith('mcp__')) {
      const server = toolName.split('__')[1] ?? ''
      return server === '' ? [] : [mcpCallCandidate(server, cwd, toolName)]
    }
    return []
  }

  /** The raw text the row stores, redacted only at write (D8). */
  private commandText(toolName: string, toolInput: unknown): string {
    if (toolName === 'Bash' || toolName === 'Monitor') {
      return String((toolInput as { command?: unknown } | null)?.command ?? '')
    }
    return `${toolName} ${JSON.stringify(toolInput ?? {})}`
  }

  private outcome(
    toolUseId: string,
    outcome: OutboundOutcomeInsert['outcome'],
    durationMs?: number,
    detail?: () => string,
  ): void {
    const entry = this.pendingSends.get(toolUseId)
    if (entry === undefined) return
    if (outcome !== 'started-background') this.pendingSends.delete(toolUseId)
    const createdAt = (this.options.now ?? (() => new Date().toISOString()))()
    this.defer(() => {
      this.options.store.insertOutcome({
        sessionId: this.options.sessionId,
        toolUseId,
        outcome,
        ...(detail === undefined ? {} : { detail: detail() }),
        ...(durationMs === undefined ? {} : { durationMs }),
        createdAt,
      })
    })
  }

  /** Judge, redact, and append the call row (deferred, never on the hook path). */
  private writeCall(toolUseId: string, entry: PendingSend): void {
    const repos = new Map<string, ResolvedRepoFacts>()
    for (const candidate of entry.candidates) {
      const facts = this.options.repos.factsFor(candidate.cwd)
      if (facts !== null && !repos.has(facts.root)) repos.set(facts.root, facts)
    }
    const judged = entry.candidates.map(candidate => judge(candidate, { destinations: this.options.destinations, repos }))
    const best = strongest(judged)
    if (best === null) return
    const cwdFacts = [...repos.values()].find(facts => entry.cwd === facts.root || entry.cwd.startsWith(`${facts.root}/`))
    const command = redactForStore(entry.command)
    const field = (text: string): string => redactForStore(text, 4096).text
    const context = this.options.context()
    this.options.store.insertCall({
      id: `obc-${this.newId()}`,
      teamId: cwdFacts?.teamId ?? this.options.teamIdFallback(),
      sessionId: this.options.sessionId,
      spawnId: entry.spawnId,
      ...(context.groupId === undefined ? {} : { groupId: context.groupId }),
      ...(context.profileId === undefined ? {} : { profileId: context.profileId }),
      ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
      ...(entry.agentId === undefined ? {} : { agentId: entry.agentId }),
      tool: entry.tool,
      ...(entry.mcpServer === undefined ? {} : { mcpServer: entry.mcpServer }),
      toolUseId,
      command: command.text,
      truncated: command.truncated,
      rule: best.rule,
      verdict: best.verdict,
      destination: field(best.destination),
      matches: this.cappedMatches(judged, field, best),
      classifierVersion: CLASSIFIER_VERSION,
      cwd: entry.cwd,
      createdAt: (this.options.now ?? (() => new Date().toISOString()))(),
    })
  }

  /**
   * The match list as JSON, every field capped at 4096 and the whole string
   * kept under 4096: the strongest match leads, trailing matches drop when
   * they do not fit, and a final `truncated` entry marks the cut (D6 rows
   * stay bounded whatever the command).
   */
  private cappedMatches(judged: JudgedCandidate[], field: (text: string) => string, best: JudgedCandidate | null): string {
    const ordered = judged.slice().sort((a, b) => (a === best ? -1 : b === best ? 1 : 0))
    const entries = ordered.map(candidate => ({
      rule: candidate.rule,
      segment: field(candidate.segment),
      verdict: candidate.verdict,
      destination: field(candidate.destination),
    }))
    let kept = entries
    let truncated = false
    while (JSON.stringify(kept).length > 4096 && kept.length > 1) { kept = kept.slice(0, -1); truncated = true }
    // One entry can still overflow: shrink its longest field after
    // serialization until the whole string fits (round 5 R6).
    while (JSON.stringify(kept).length > 4096) {
      const widest = kept.reduce((a, b) => (b.segment.length > a.segment.length || b.destination.length > a.destination.length ? b : a), kept[0]!)
      if (widest.segment.length >= widest.destination.length) widest.segment = widest.segment.slice(0, Math.ceil(widest.segment.length / 2))
      else widest.destination = widest.destination.slice(0, Math.ceil(widest.destination.length / 2))
      truncated = true
      if (widest.segment.length === 0 && widest.destination.length === 0) break
    }
    return JSON.stringify(truncated ? [...kept, { truncated: true }] : kept)
  }
}

// The outbound observer (execution-safety-recovery D3, D5, D7): what the
// driver's four audit hooks hand each audited tool use to. Its synchronous
// part is pure parsing — a send candidate lands in the in-memory
// `pendingSends` map before the Pre hook returns, so an outcome that beats
// the queued call row is never dropped — and every file read or database
// write is queued behind a catch-all, because an uncaught microtask throw
// would exit Bun. Purely observational: nothing here blocks, delays, or
// denies a tool call, and an observer failure never fails the call. Team
// mail (`mcp__kawai-team__*`) is never recorded — the mailbox already is.
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

  constructor(private readonly options: OutboundObserverOptions) {}

  spawnIsLive(spawnId: string): boolean {
    return this.liveSpawns.has(spawnId)
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
    queueMicrotask(() => {
      try {
        this.writeCall(use.toolUseId, entry)
      } catch {
        // A failed write is a lost audit row, never a failed tool call.
      }
    })
  }

  onPostToolUse(use: Parameters<OutboundAuditSink['onPostToolUse']>[0]): void {
    // A background call is not terminal: its later fate shows in the roster.
    this.outcome(use.toolUseId, use.background ? 'started-background' : 'completed', use.durationMs)
  }

  onPostToolUseFailure(use: Parameters<OutboundAuditSink['onPostToolUseFailure']>[0]): void {
    const detail = use.isInterrupt === true ? `${redact(use.error)} (interrupt)` : redact(use.error)
    this.outcome(use.toolUseId, 'failed', use.durationMs, detail.slice(0, 1024))
  }

  onPermissionDenied(use: Parameters<OutboundAuditSink['onPermissionDenied']>[0]): void {
    this.outcome(use.toolUseId, 'denied', undefined, redact(use.reason).slice(0, 1024))
  }

  onDeniedCard(use: Parameters<OutboundAuditSink['onDeniedCard']>[0]): void {
    const detail = use.reason === undefined ? undefined : redact(use.reason).slice(0, 1024)
    this.outcome(use.toolUseId, 'denied', undefined, detail)
  }

  onSpawnEnd(spawnId: string): void {
    this.liveSpawns.delete(spawnId)
    for (const [toolUseId, entry] of this.pendingSends) {
      if (entry.spawnId === spawnId) this.pendingSends.delete(toolUseId)
    }
  }

  /** Candidates for one tool use: parsed shell command, or one external MCP call (D5). */
  private candidatesOf(toolName: string, toolInput: unknown, cwd: string): SendCandidate[] {
    if (toolName === 'Bash' || toolName === 'Monitor') {
      const command = (toolInput as { command?: unknown } | null)?.command
      return typeof command === 'string' ? parseSends(command, cwd) : []
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

  private outcome(toolUseId: string, outcome: OutboundOutcomeInsert['outcome'], durationMs?: number, detail?: string): void {
    const entry = this.pendingSends.get(toolUseId)
    if (entry === undefined) return
    if (outcome !== 'started-background') this.pendingSends.delete(toolUseId)
    const createdAt = (this.options.now ?? (() => new Date().toISOString()))()
    queueMicrotask(() => {
      try {
        this.options.store.insertOutcome({
          sessionId: this.options.sessionId,
          toolUseId,
          outcome,
          ...(detail === undefined ? {} : { detail }),
          ...(durationMs === undefined ? {} : { durationMs }),
          createdAt,
        })
      } catch {
        // Observational only.
      }
    })
  }

  /** Judge, redact, and append the call row (queued, never on the hook path). */
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
    const context = this.options.context()
    this.options.store.insertCall({
      id: `obc-${(this.options.id ?? crypto.randomUUID)()}`,
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
      destination: redact(best.destination),
      matches: JSON.stringify(judged.map((candidate: JudgedCandidate) => ({
        rule: candidate.rule,
        segment: redact(candidate.segment),
        verdict: candidate.verdict,
        destination: redact(candidate.destination),
      }))),
      classifierVersion: CLASSIFIER_VERSION,
      cwd: entry.cwd,
      createdAt: (this.options.now ?? (() => new Date().toISOString()))(),
    })
  }
}

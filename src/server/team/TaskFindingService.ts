// Structured findings (review-findings-ledger D4, D5): one submission planned
// against the task's ledger and written in one immediate transaction, so
// finding ids and `ledger_seq` stay dense and a refusal writes nothing (I3).
// TaskResultService keeps the caller, team, result, and ownership refusals
// and hands a structured submission here. The ledger itself is never stored:
// `ledger(taskId)` folds the counted submissions and events on every read,
// the one derivation every reader uses (I2).
import { blocking, deriveVerdict, foldLedger, planSubmission, type LedgerRow, type SubmittedDisposition, type SubmittedFinding } from '../../shared/findingsLedger'
import type { CitationContext, ScopeView } from '../../shared/reviewFindings'
import type { ResultScopeFact, TaskActor, TaskFindings, TaskResult, TeamTask } from '../../shared/teamTasks'
import { inScope } from '../verification/scopeFact'
import type { TaskStore } from './taskStore'
import { FindingDisputes } from './findingDisputes'

export interface StructuredSubmission {
  kind: TaskFindings['kind']
  verdict?: TaskFindings['verdict']
  notes?: string | null
  findings: SubmittedFinding[]
  dispositions: SubmittedDisposition[]
}

export interface StructuredOutcome {
  findings: TaskFindings
  verdict: 'pass' | 'fail'
  counted: boolean
  /** Each item's id, class, and reason (spec: the tool's reply lists them). */
  items: Array<{ id: string; kind: 'finding' | 'disposition'; class: string | null; reason: string | null; disposition: string | null }>
  replaced: string | null
}

export interface FindingServiceOptions {
  /** The newest scope fact of a result (implementation-contract D6); null when none is recorded yet. */
  scopeFact?: (resultId: string) => ResultScopeFact | null
  /** Whether a plan round with this result is decided (D5's third finality rule). */
  roundDecided?: (resultId: string) => boolean
  /** A ledger write landed (a dispute or a decision): the composition wakes the owner's executor. */
  onWrite?: (taskId: string) => void
}

/** The pinned revision a result is judged against. */
export function pinnedContext(store: TaskStore, task: TeamTask, result: TaskResult): CitationContext {
  const revision = store.revisions(task.id).find(entry => entry.revision === result.taskRevision)
  return { identity: revision?.identity ?? task.identity ?? `r${result.taskRevision}#000000000000`, contract: revision?.contract ?? null }
}

export class TaskFindingService {
  /** Disputes and their decisions (D6); the composition sets its card and mail ports. */
  readonly disputes: FindingDisputes
  constructor(private readonly store: TaskStore, private readonly options: FindingServiceOptions = {}) {
    this.disputes = new FindingDisputes(store, taskId => this.ledger(taskId), (taskId, findingId) => store.findings.evidenceOf(taskId, findingId), options.onWrite)
  }

  /** The task's ledger, derived now (I2). */
  ledger(taskId: string): LedgerRow[] {
    return foldLedger(this.store.findings.countedSubmissions(taskId), this.store.findings.events(taskId))
  }

  /** The effective verdict of one findings row (D5): stored for text rows, derived from the ledger for structured ones. */
  effectiveVerdict(row: TaskFindings, rows?: LedgerRow[]): 'pass' | 'fail' {
    if (!row.structured) return row.verdict
    return deriveVerdict(rows ?? this.ledger(row.taskId))
  }

  private scopeView(task: TeamTask, context: CitationContext, resultId: string): ScopeView | null {
    if (context.contract === null) return null
    const globs = context.contract.scope.map(glob => new Bun.Glob(glob))
    return {
      matchesScope: path => inScope(globs, task.openspecChange, path),
      fact: this.options.scopeFact?.(resultId) ?? null,
    }
  }

  /** D5: why a counted submission on this result can no longer be written, or null. */
  private finality(taskId: string, resultId: string): string | null {
    const findings = this.store.findings
    const submissions = findings.countedSubmissions(taskId)
    const existing = submissions.find(entry => entry.resultId === resultId)
    const created = (id: string) => this.store.results.get(id)?.createdAt ?? ''
    const mine = created(resultId)
    if (submissions.some(entry => entry.resultId !== resultId && created(entry.resultId) > mine)) {
      return 'a review of a newer result already counts'
    }
    if (existing) {
      const ids = new Set(existing.items.map(item => item.findingId))
      const event = findings.events(taskId).find(entry => entry.ledgerSeq > existing.ledgerSeq && ids.has(entry.findingId))
      if (event) return `${event.findingId} was ${event.kind} after that review`
    }
    if (this.options.roundDecided?.(resultId)) return 'its round is decided'
    return null
  }

  /** Plan and write one structured submission (D4), or throw naming every problem with nothing written. */
  submit(input: {
    teamId: string
    task: TeamTask
    result: TaskResult
    author: TaskActor & { kind: 'agent' }
    handoffId: string | null
    counted: boolean
    submission: StructuredSubmission
  }): StructuredOutcome {
    const { task, result } = input
    const findings = this.store.findings
    return this.store.immediate(() => {
      if (input.counted) {
        const final = this.finality(task.id, result.id)
        if (final !== null) throw new Error(`Findings on result ${result.id} are final: ${final}. Nothing was written.`)
      }
      const replaced = input.counted ? findings.countedOn(result.id)[0] ?? null : null
      const priorSubmissions = findings.countedSubmissions(task.id).filter(entry => entry.id !== replaced?.id)
      const events = findings.events(task.id)
      const prior = foldLedger(priorSubmissions, events)
      const context = pinnedContext(this.store, task, result)
      const ledgerSeq = findings.nextSeq(task.id)
      const createdAt = new Date().toISOString()
      const plan = planSubmission({
        prior, findings: input.submission.findings, dispositions: input.submission.dispositions, citation: context,
        scope: this.scopeView(task, context, result.id), nextNumber: findings.nextFindingNumber(task.id),
        submission: { id: 'pending', resultId: result.id, ledgerSeq, contractIdentity: context.identity, createdAt },
        priorSubmissions, events,
      })
      if (!plan.ok) throw new Error(`Findings refused, nothing was written: ${plan.problems.join('; ')}`)
      if (input.submission.verdict !== undefined && input.submission.verdict !== plan.verdict) {
        throw new Error(`The submitted verdict ${input.submission.verdict} differs from the derived verdict ${plan.verdict}; omit verdict or send ${plan.verdict}. Nothing was written.`)
      }
      const notes = input.submission.notes?.trim() || summarize(plan.items, plan.after)
      const id = findings.insertSubmission({
        teamId: input.teamId, taskId: task.id, resultId: result.id, handoffId: input.handoffId, kind: input.submission.kind,
        verdict: plan.verdict, notes, author: input.author, counted: input.counted, contractIdentity: context.identity,
        ledgerSeq, items: plan.items,
      }, createdAt)
      if (replaced) findings.markReplaced(replaced.id, id)
      const stored = this.store.results.findingsFor(result.id).find(row => row.id === id)!
      return {
        findings: stored, verdict: plan.verdict, counted: input.counted, replaced: replaced?.id ?? null,
        items: plan.items.map(item => ({ id: item.findingId, kind: item.itemKind, class: item.class, reason: item.reason, disposition: item.disposition })),
      }
    })
  }
}

/** The stored text of a structured row without notes: `3 findings: F1 accepted P1, …`. */
function summarize(items: readonly { findingId: string; itemKind: string; level: string; class: string | null; disposition: string | null }[], after: readonly LedgerRow[]): string {
  if (items.length === 0) return `No findings; ${blocking(after).length} blocking.`
  const parts = items.map(item => item.itemKind === 'disposition'
    ? `${item.findingId} ${item.disposition}`
    : `${item.findingId} ${item.class} ${item.level}`)
  return `${items.length} item${items.length === 1 ? '' : 's'}: ${parts.join(', ')}`
}

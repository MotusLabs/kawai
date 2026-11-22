// Task tools on the per-session `kawai-team` MCP server (team-tasks design
// D2). Handlers bind the calling session id and strip unknown arguments, so
// a forged creator or team in the input is never seen by the service.
// `task_transfer_owner` moves ownership (group-mail-task-affinity D7).
// `task_get`, `task_journal_read`, and `task_result_diff_read` read through
// one TaskJournalReads (bounded-log-reads-and-task-get D4–D6,
// bounded-task-reads D5–D10): bounded windows and byte-bounded previews, any
// entry or diff whole, behind task_get's caller and team rules.
import { z } from 'zod'
import { TASK_STATUSES, type TaskListStatus, type TaskStatus } from '../../shared/teamTasks'
import type { TaskService } from './TaskService'
import type { TaskResultService } from './TaskResultService'
import { JOURNAL_LIMIT_MAX, TaskJournalReads } from './taskJournalWindow'
import { TASK_LIST_LIMIT_MAX, TASK_LIST_STATUSES } from './taskListWindow'
import { PREPARED_PAYLOAD_FIELDS } from './taskHandoffService'

export const TASK_TOOL_NAMES = ['task_create', 'task_get', 'task_journal_read', 'task_result_diff_read', 'task_note', 'task_update_status', 'task_amend', 'task_list', 'task_acknowledge',
  'task_submit_result', 'task_submit_coverage', 'task_submit_findings', 'task_dispute_findings', 'task_decide_dispute', 'task_handoff', 'task_check_result', 'task_transfer_owner', 'task_request_publication',
  'task_settle_publication'] as const

const status = z.enum(TASK_STATUSES as [TaskStatus, ...TaskStatus[]])
const taskId = { task_id: z.string().min(1) }
// One message for every failure, so both runtimes' refusals name the range (D5).
const journalLimit = `journal_limit must be an integer from 1 to ${JOURNAL_LIMIT_MAX}`
// The same for task_list (bounded-task-list D2/D3): one message per argument.
const listStatus = `status must be one of ${TASK_LIST_STATUSES.join(', ')}`
const listLimit = `limit must be an integer from 1 to ${TASK_LIST_LIMIT_MAX}`
// bounded-metrics-and-task-get D7: a revision argument that is not a number is refused naming the
// value, as the store refuses a number outside the task's revisions.
const unknownRevision = { error: (issue: { input?: unknown }) => `Unknown revision of this task: ${String(issue.input)}` }
const offsetBytes = 'offset_bytes must be a safe non-negative integer'
const offsetSchema = z.number({ error: offsetBytes }).int({ error: offsetBytes }).min(0, { error: offsetBytes })
  .max(Number.MAX_SAFE_INTEGER, { error: offsetBytes }).optional()
// bounded-task-reads D5–D9: a section anchor of the wrong type is refused naming the argument;
// a string anchor that is not the task's is refused by the store, naming the id.
const anchorId = (name: string) => z.string({ error: `${name} must be an id string` }).optional()
const unknownPublication = { error: (issue: { input?: unknown }) => `Unknown publication of this task: ${String(issue.input)}` }
const acknowledgementAnchor = 'acknowledgements_before must be { session_id, revision } of an acknowledgement of this task'
export const taskSchemas = {
  task_create: z.object({
    title: z.string().min(1), direction: z.string().min(1), acceptance: z.string().optional(), contract: z.string().optional(),
    parent_id: z.string().optional(), worktree: z.string().optional(), openspec_change: z.string().optional(),
    plan_id: z.string().optional(), plan_change: z.string().optional(),
  }),
  task_get: z.object({
    ...taskId, journal_before: z.string().min(1).optional(),
    journal_limit: z.number({ error: journalLimit }).int({ error: journalLimit }).min(1, { error: journalLimit })
      .max(JOURNAL_LIMIT_MAX, { error: journalLimit }).optional(),
    revisions_before: z.number(unknownRevision).optional(),
    revision: z.number(unknownRevision).optional(),
    subtasks_before: anchorId('subtasks_before'),
    messages_before: anchorId('messages_before'),
    full_messages: z.boolean({ error: 'full_messages must be a boolean' }).optional(),
    results_before: anchorId('results_before'),
    result_id: anchorId('result_id'),
    assignments_before: anchorId('assignments_before'),
    publications_before: z.number(unknownPublication).optional(),
    acknowledgements_before: z.object({
      session_id: z.string({ error: acknowledgementAnchor }), revision: z.number({ error: acknowledgementAnchor }),
    }, { error: acknowledgementAnchor }).optional(),
  }),
  task_journal_read: z.object({ ...taskId, entry_id: z.string().min(1), offset_bytes: offsetSchema }),
  task_result_diff_read: z.object({ ...taskId, result_id: z.string().min(1), offset_bytes: offsetSchema }),
  task_note: z.object({ ...taskId, text: z.string().min(1) }),
  task_update_status: z.object({ ...taskId, status, note: z.string().optional() }),
  task_amend: z.object({
    ...taskId, direction: z.string().optional(), acceptance: z.string().optional(), contract: z.string().optional(),
    rationale: z.string().optional(), notify: z.boolean().optional(),
    // Publish a prepared revision (owner-publication-handoff D3): beside it only task_id.
    handoff_id: z.string().min(1).optional(),
  }),
  // owner-publication-handoff D10: a prepared revision for the owner or the human to publish.
  task_request_publication: z.object({
    ...taskId, base_revision: z.number().int().min(1), rationale: z.string(),
    direction: z.string().optional(), acceptance: z.string().optional(), contract: z.string().optional(),
    notify: z.boolean().optional(), base_commit: z.string().optional(), evidence_refs: z.array(z.string()).optional(),
    request_key: z.string().min(1),
  }),
  // The reason is checked after the right (H-SETTLE's order), so it may arrive empty here.
  task_settle_publication: z.object({ handoff_id: z.string().min(1), action: z.enum(['decline', 'withdraw']), reason: z.string() }),
  task_list: z.object({
    status: z.enum(TASK_LIST_STATUSES as [TaskListStatus, ...TaskListStatus[]], { error: listStatus }).optional(),
    limit: z.number({ error: listLimit }).int({ error: listLimit }).min(1, { error: listLimit })
      .max(TASK_LIST_LIMIT_MAX, { error: listLimit }).optional(),
    before: z.string().min(1).optional(),
  }),
  task_acknowledge: z.object({ ...taskId, revision: z.number().int().min(1) }),
  task_submit_result: z.object({
    ...taskId, summary: z.string().min(1), commit: z.string().optional(), diff: z.string().optional(),
    tests: z.array(z.object({ description: z.string().min(1), outcome: z.string().min(1) })).optional(),
    limitations: z.string().optional(),
    // The coverage map's shape is D5's, checked by validateCoverageMap at the
    // service boundary — a clause-indexed refusal the zod layer cannot name.
    coverage: z.unknown().optional(),
  }),
  task_submit_coverage: z.object({
    ...taskId, result_id: z.string().min(1), coverage: z.unknown(),
  }),
  // review-findings-ledger D4: text with a verdict, or structured items and
  // dispositions with a derived (optional, checked) verdict.
  task_submit_findings: z.object({
    ...taskId, result_id: z.string().min(1), kind: z.enum(['review', 'qa']), verdict: z.enum(['pass', 'fail']).optional(),
    findings: z.string().optional(),
    items: z.array(z.object({
      id: z.string().regex(/^F[1-9]\d*$/, { error: 'a finding id is F<n>' }).optional(), level: z.enum(['P0', 'P1', 'P2']),
      clause: z.string().optional(), evidence: z.string().optional(), impact: z.string().optional(), reproduction: z.string().optional(),
    })).optional(),
    dispositions: z.array(z.object({
      id: z.string().regex(/^F[1-9]\d*$/, { error: 'a finding id is F<n>' }), disposition: z.enum(['resolved', 'still-open', 'regressed']),
      evidence: z.string().optional(),
    })).optional(),
  }),
  // review-findings-ledger D6: the author's dispute, and the non-plan decision.
  task_dispute_findings: z.object({
    ...taskId, disputes: z.array(z.object({ id: z.string().regex(/^F[1-9]\d*$/, { error: 'a finding id is F<n>' }), counter_evidence: z.string() })).min(1),
  }),
  task_decide_dispute: z.object({
    ...taskId, finding_id: z.string().regex(/^F[1-9]\d*$/, { error: 'a finding id is F<n>' }), decision: z.enum(['uphold', 'reject']), rationale: z.string(),
  }),
  task_handoff: z.object({
    ...taskId, kind: z.enum(['review', 'qa', 'fix']), result_id: z.string().min(1), target: z.string().min(1),
    // Explicit recipient kind (session-targeted-task-handoffs D1): omitted
    // means group, even when the id resembles a session id — never inferred.
    target_kind: z.enum(['group', 'session']).optional(),
    instructions: z.string().min(1), expected_response: z.string().optional(),
    // The worker choice (dispatch-worker-choice D7): group targets only.
    worker: z.string().min(1).optional(),
  }),
  task_check_result: z.object({ ...taskId, result_id: z.string().min(1) }),
  task_transfer_owner: z.object({
    task_id: z.string().min(1).optional(), from_session: z.string().min(1).optional(),
    to_session: z.string().min(1).optional(), reason: z.string().optional(),
  }),
}

export const taskDescriptions: Record<(typeof TASK_TOOL_NAMES)[number], string> = {
  task_create: 'Create a team task (only if your group may create tasks). Optional parent_id, worktree (a worktree root of this repository), and openspec_change; plan_id with plan_change links the task to a change of an open plan\'s approved revision (both or neither; fixed afterwards). Optional contract: an implementation contract in Markdown — a `## Implementation contract` heading, then `### Acceptance`, `### Invariants`, `### Scope`, `### Verification`, `### Excluded` in that order, clauses as `- A1: text` (I, V, X likewise), Scope as one glob per bullet; Acceptance, Scope, and Verification need at least one entry. A contract that does not parse refuses the creation with every problem and its line. You become its creator.',
  task_get: 'Read a task, bounded on every call: the current direction, acceptance, contract, and assignment (task) whole; every growing list a window with its total in bounds.<list> (total, returned, truncated when older rows remain, nextBefore to continue). The journal: the newest 50 entries (journal_limit 1–200), oldest first, each a preview of at most 2,000 stored bytes with totalBytes, cut, and resumeOffsetBytes (text null when not valid UTF-8); page older with journal_before set to bounds.journal.nextBefore, and read any entry whole with task_journal_read. subtasks: the newest 100, oldest first, as task_list rows (no direction or acceptance); page with subtasks_before. messages: the newest 50, oldest first, each body a preview of at most 2,000 UTF-8 bytes with bodyBytes and bodyCut; page with messages_before; full_messages: true returns whole bodies in the same window (potentially large). revisions lists the newest 50 revisions oldest first as rows — revision, identity (r<revision>#<hash>), contractHash (null without a contract), author, createdAt, notify, directionBytes, acceptanceBytes, and a rationale preview of at most 2,000 stored bytes with rationaleBytes and rationaleCut — never their direction or acceptance; bounds.revisions has total, returned, truncated, and nextBefore, and revisions_before (an integer from 2 to the task\'s revision) returns the revisions below it. Read one revision whole with revision (an integer from 1 to the task\'s revision): revisionText carries its direction, acceptance, and rationale. results: the outstanding result first, whole and sealed, then the newest 50 other results newest first as rows (id, commit, taskRevision, submittedBy, supersededBy, acceptedAt, reviewVerdict, createdAt, and a 2,000-byte summary preview with summaryBytes and summaryCut — no findings, maps, or diff); page with results_before (bounds.results.nextBefore; total excludes the outstanding result). result_id returns that result whole as resultDetail, sealed the same way. In a whole result the diff is a preview of at most 8,192 bytes with diffBytes, diffCut, and diffResumeOffsetBytes; read the whole diff with task_result_diff_read. assignments: the newest 50, oldest first, without their instruction (task.assignment keeps the current one\'s); page with assignments_before. publications: the newest 50, oldest first, each rationale a 2,000-byte preview with rationaleBytes and rationaleCut (revision reads it whole); page with publications_before (a revision number). acknowledgements: the newest 50, oldest first; page with acknowledgements_before ({ session_id, revision }). An anchor that is not this task\'s is refused naming it. Not byte-bounded: the current direction, acceptance, and instruction, whole results apart from their diff, revisionText, full_messages bodies, publication recipients, and task participants. findingsLedger lists the newest 100 findings (F<n>), newest first, each with level, clause, state, and transitions (ledgerOlderRemaining when more exist); each whole result\'s findings rows carry their items, class, and whether they counted. A Codex thread started before these arguments existed keeps its original catalogue and cannot use them.',
  task_journal_read: 'Read one journal entry of a task losslessly (entry_id from task_get): up to 8,192 stored bytes from offset_bytes (default 0; a preview\'s resumeOffsetBytes continues it) as dataBase64, which is authoritative, with their text when valid UTF-8 (else null), the entry\'s totalBytes, and nextOffsetBytes (null at the end). Read-only.',
  task_result_diff_read: 'Read one result\'s diff losslessly (result_id from task_get): up to 8,192 stored bytes from offset_bytes (default 0; a whole result\'s diffResumeOffsetBytes continues its preview) as dataBase64, which is authoritative, with their text when valid UTF-8 (else null), the diff\'s totalBytes (0 without a diff), and nextOffsetBytes (null at the end). Read-only.',
  task_note: "Append a note to a task's journal (decisions, findings, progress). Notes are permanent.",
  task_update_status: 'Set a task to active or blocked (any member); done or cancelled (its owner only). Optional note is journaled.',
  task_amend: "Publish a new revision of a task's direction, acceptance criteria, or contract (its owner only). Optional contract (the task_create grammar) replaces the current one; omitted or blank carries it forward unchanged, and a contract can never be removed. A contract that does not parse refuses the amendment with every problem and publishes nothing. Optional rationale says why; notify: true also sends the assignment's claimed agent a revision notice. With handoff_id (and only task_id beside it) publishes that prepared revision as it was requested.",
  task_request_publication: 'Ask the task\'s owner (or the human, when the task has no live owner) to publish a revision you prepared, when you may author task directions but do not own the task: base_revision (the task\'s current revision), a rationale, and at least one of direction, acceptance, contract (the task_create grammar); notify (default true) also sends the holder a revision notice when it is published. Optional base_commit (a full commit id) and up to 20 evidence_refs (repository-relative paths or ids). request_key makes a resend a replay; the same key with a different payload is refused naming the field. A newer request of yours supersedes your pending one; another group\'s pending request refuses it. This publishes nothing: the owner publishes it with task_amend { task_id, handoff_id }. A decision card answer publishes nothing either.',
  task_settle_publication: 'End a pending publication handoff (handoff_id from task_get) with a reason: action "withdraw" for the requester or a session of its group (nobody is woken), or "decline" for the task\'s owner (the requester is woken). Publishing it is task_amend { task_id, handoff_id }; nothing else settles a handoff.',
  task_list: `List this team's tasks as compact rows (no direction or acceptance — use task_get), newest first. Without status, only open, active, and blocked tasks; status takes one status or "all". At most limit rows (1–${TASK_LIST_LIMIT_MAX}, default 50); page older with before set to bounds.nextBefore. bounds.total counts every match; statuses names the filter applied.`,
  task_acknowledge: 'State the published task revision you are now working from (the revision in the task header). Call it when you start or take over work on a task, and after a revision notice.',
  task_submit_result: 'Submit a result for a task: a summary, a commit and/or diff reference (at least one), the tests you ran with their outcomes, and known limitations. Your test outcomes are shown as claimed, not verified. Supersedes the task\'s previous result; does not close the task.',
  task_submit_coverage: 'Record your own coverage map for a result (result_id from task_get): the same clause/citation map a submission carries. While you hold a task\'s outstanding review handoff and have recorded no map for its result, the submitter\'s maps stay withheld from you — recording yours unseals them. Maps are append-only; your newest map for a result counts.',
  task_submit_findings: 'Report review or QA findings on one exact result (result_id from task_get), kind review|qa. Structured (required for a plan change\'s review): items, each with level P0 (security, data corruption, severe correctness) | P1 (a reproducible requirement violation, a significant regression) | P2 (advisory, never blocks), the clause it violates (A1, or r<N>#<hash> › A1; on a task without a contract, its revision identity), evidence (file:line, test output, or a counterexample), impact, and an optional reproduction; and dispositions resolved | still-open | regressed (the latter two with evidence) for every blocking finding listed in task_get. The verdict is derived (fail exactly when a P0/P1 is accepted and open); the reply lists each item\'s class. Text form: findings and verdict pass|fail. Findings stay bound to that result — a newer result inherits nothing.',
  task_handoff: 'Hand a result off (kind review, qa, or fix — return for fixes; the result_id, instructions, and an optional expected_response) to a recipient: target_kind "group" (the default when omitted, even for a session-shaped id) with target: <group id>, or target_kind "session" with target: <session id> to dispatch ordinary direct task mail to that exact session — no other member is chosen. While an equivalent handoff (same task, result, kind) is outstanding, this returns it instead of dispatching again; if the standing handoff names another recipient, the notice says so and nothing is reassigned. Optional worker (group targets only) limits who may take it to one provider (e.g. claude) or one model (provider/model, or a bare model key) of the group\'s workers, as on send_message; a handoff naming another worker is another handoff.',
  task_transfer_owner: "Move a task's ownership (its amend and close rights) within your group. As the owner, give task_id and to_session to hand it to another live session of your group before you leave it. To take over, give task_id, or from_session for every open, active, and blocked task of that owner, once the owner is archived, gone, or context-exhausted; a takeover moves tasks only to you, and a live owner is never taken over — message it instead. Optional reason. Every move is journaled; the creator stays recorded as author.",
  task_dispute_findings: 'Dispute blocking findings of a task whose result you submitted, instead of changing code for a finding you can refute: each with its id (F<n> from task_get) and counter-evidence (a test run, file:line, a counterexample), at most 10 per call. A disputed finding waits for a decision: a decision card for the plan\'s Lead role (or the owner) on a plan change\'s task, else the task creator decides with task_decide_dispute. A finding is disputed at most once in each state it enters.',
  task_decide_dispute: 'Decide a dispute of a finding on a task you own that is not a plan change\'s task (those are decided on their decision cards): uphold (the finding blocks again) or reject (it never blocks), with a rationale that is journaled.',
  task_check_result: 'Ask Kawai to check a result again (result_id from task_get): the commit, its worktree state, the recorded full-check pass, and merges against the base and other open tasks\' branches. The check never gates anything; it runs in the background and the newest check rides task_get. A request while a check is pending returns that pending check.',
}

export function taskHandlers(tasks: TaskService, sessionId: string, results?: TaskResultService) {
  const caller = { kind: 'agent' as const, sessionId }
  const reads = new TaskJournalReads(tasks)
  return {
    task_create: async (input: unknown) => tasks.create(caller, taskSchemas.task_create.parse(input)),
    task_get: async (input: unknown) => {
      const args = taskSchemas.task_get.parse(input)
      const anchor = args.acknowledgements_before
      // The blind-first seal (independent-verification D6): the read
      // transaction projects every whole result for the reading session when
      // the server has a result service (bounded-task-reads D10); the human's
      // path (humanDetail) never seals.
      return reads.agentGet(caller, args.task_id, {
        journalBefore: args.journal_before, journalLimit: args.journal_limit, revisionsBefore: args.revisions_before, revision: args.revision,
        subtasksBefore: args.subtasks_before, messagesBefore: args.messages_before, fullMessages: args.full_messages,
        resultsBefore: args.results_before, resultId: args.result_id, assignmentsBefore: args.assignments_before,
        publicationsBefore: args.publications_before,
        acknowledgementsBefore: anchor === undefined ? undefined : { sessionId: anchor.session_id, revision: anchor.revision },
      }, results?.wholeResultSeal(caller, args.task_id))
    },
    task_journal_read: async (input: unknown) => {
      const { task_id, entry_id, offset_bytes } = taskSchemas.task_journal_read.parse(input)
      return reads.journalRead(caller, task_id, entry_id, offset_bytes ?? 0)
    },
    task_result_diff_read: async (input: unknown) => {
      const { task_id, result_id, offset_bytes } = taskSchemas.task_result_diff_read.parse(input)
      return reads.diffRead(caller, task_id, result_id, offset_bytes ?? 0)
    },
    task_note: async (input: unknown) => {
      const { task_id, text } = taskSchemas.task_note.parse(input)
      return tasks.note(caller, task_id, text)
    },
    task_update_status: async (input: unknown) => {
      const { task_id, status: next, note } = taskSchemas.task_update_status.parse(input)
      return tasks.setStatus(caller, task_id, next, note)
    },
    task_amend: async (input: unknown) => {
      const { task_id, direction, acceptance, contract, rationale, notify, handoff_id } = taskSchemas.task_amend.parse(input)
      if (handoff_id !== undefined) {
        const given = { direction, acceptance, contract, rationale, notify }
        const extras = PREPARED_PAYLOAD_FIELDS.filter(field => given[field] !== undefined)
        return (await tasks.handoffs.publish(caller, task_id, handoff_id, extras)).task
      }
      return tasks.amend(caller, task_id, { direction, acceptance, contract, rationale, notify })
    },
    task_request_publication: async (input: unknown) => {
      const args = taskSchemas.task_request_publication.parse(input)
      return tasks.handoffs.request(caller, args.task_id, {
        baseRevision: args.base_revision, rationale: args.rationale, direction: args.direction, acceptance: args.acceptance,
        contract: args.contract, notify: args.notify ?? true, baseCommit: args.base_commit, evidenceRefs: args.evidence_refs,
        requestKey: args.request_key,
      })
    },
    task_settle_publication: async (input: unknown) => {
      const args = taskSchemas.task_settle_publication.parse(input)
      return tasks.handoffs.settle(caller, args.handoff_id, args.action, args.reason)
    },
    task_acknowledge: async (input: unknown) => {
      const { task_id, revision } = taskSchemas.task_acknowledge.parse(input)
      return tasks.acknowledge(caller, task_id, revision)
    },
    // Results (task-results-handoffs): registered only where the server has a result service.
    ...(results ? {
      task_submit_result: async (input: unknown) => {
        const { task_id, ...submission } = taskSchemas.task_submit_result.parse(input)
        return results.submit(caller, task_id, submission)
      },
      task_submit_coverage: async (input: unknown) => {
        const { task_id, result_id, coverage } = taskSchemas.task_submit_coverage.parse(input)
        return results.submitCoverage(caller, task_id, { resultId: result_id, coverage })
      },
      task_submit_findings: async (input: unknown) => {
        const { task_id, result_id, kind, verdict, findings, items, dispositions } = taskSchemas.task_submit_findings.parse(input)
        return results.submitFindings(caller, task_id, {
          resultId: result_id, kind, findings,
          ...(verdict !== undefined ? { verdict } : {}),
          ...(items !== undefined ? { items } : {}),
          ...(dispositions !== undefined ? { dispositions } : {}),
        })
      },
      task_dispute_findings: async (input: unknown) => {
        const { task_id, disputes } = taskSchemas.task_dispute_findings.parse(input)
        return results.disputeFindings(caller, task_id, disputes.map(entry => ({ id: entry.id, counterEvidence: entry.counter_evidence })))
      },
      task_decide_dispute: async (input: unknown) => {
        const { task_id, finding_id, decision, rationale } = taskSchemas.task_decide_dispute.parse(input)
        return results.decideDispute(caller, task_id, { findingId: finding_id, decision, rationale })
      },
      task_handoff: async (input: unknown) => {
        const { task_id, kind, result_id, target_kind, target, instructions, expected_response, worker } = taskSchemas.task_handoff.parse(input)
        const id = target.trim()
        if (!id) throw new Error('A handoff target needs an identifier')
        return results.handoff(caller, task_id, {
          kind, resultId: result_id, target: { kind: target_kind ?? 'group', id }, instructions, expectedResponse: expected_response ?? null,
          ...(worker !== undefined ? { worker } : {}),
        })
      },
      task_check_result: async (input: unknown) => {
        const { task_id, result_id } = taskSchemas.task_check_result.parse(input)
        return results.recheck(caller, task_id, result_id)
      },
    } : {}),
    task_list: async (input: unknown) => tasks.agentList(caller, taskSchemas.task_list.parse(input)),
    task_transfer_owner: async (input: unknown) => tasks.ownership.transfer(caller, taskSchemas.task_transfer_owner.parse(input)),
  }
}

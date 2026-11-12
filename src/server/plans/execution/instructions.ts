// The instruction texts Kawai dispatches (plan-execution D7, D11). The
// implement attempt tells the implementer where the worktree is, what the
// baseline and head are, what acceptance and extra checks gate the round,
// and to run the project's setup itself — Kawai runs no project commands.
// Long lists are cut at fixed limits with a pointer to `task_get` and
// `plan_get`, so an instruction never grows without bound (D7's risk).
// It names the task's contract identity, or says it has none
// (implementation-contract D4).
export interface ImplementInstructionInput {
  planTitle: string
  revision: number
  change: string
  worktree: string
  branch: string
  baseline: string
  head: string
  acceptance: string[]
  extraChecks: string[]
  guidance: string
  taskId: string
  manifestHash: string
  /** integration-candidates D12: the plan lands on this integration branch, the change's base; Kawai alone writes it. */
  integrationBranch?: string | null
  /** The task's current identity `r<revision>#<hash>` and whether it carries a contract; omitted, no contract line. */
  contract?: { identity: string; present: boolean }
}

/** A task's contract facts for the instruction; undefined when the task is unknown. */
export function instructionContract(task: { identity?: string; contract?: unknown } | null | undefined): ImplementInstructionInput['contract'] {
  return task?.identity ? { identity: task.identity, present: task.contract != null } : undefined
}

/** The contract line (implementation-contract D4): the identity reviewers cite, or none. */
function contractLine(contract: ImplementInstructionInput['contract']): string | null {
  if (contract === undefined) return null
  return contract.present
    ? `Implementation contract: ${contract.identity} (task_get shows its clauses and scope). Work within its scope; reviewers judge the result against it and cite clauses as ${contract.identity} › <id>.`
    : `Implementation contract: none (revision identity ${contract.identity}); the direction and the change's artifacts are the whole brief.`
}

const LIST_CHARS = 600
const cut = (lines: string[]): { text: string; cut: boolean } => {
  const joined = lines.join('\n')
  return joined.length <= LIST_CHARS ? { text: joined, cut: false } : { text: joined.slice(0, LIST_CHARS), cut: true }
}

export function implementInstruction(input: ImplementInstructionInput): string {
  const acceptance = cut(input.acceptance)
  const checks = cut(input.extraChecks)
  return [
    `Implement the OpenSpec change "${input.change}" of plan "${input.planTitle}" (revision ${input.revision}).`,
    `Worktree: ${input.worktree} (branch ${input.branch}, baseline ${input.baseline}, head ${input.head}). The branch is yours: commit to it; never force a push.`,
    input.integrationBranch ? `Base: the integration branch ${input.integrationBranch} — your branch starts from it and lands on it. Kawai alone writes ${input.integrationBranch} (it fast-forwards it and promotes it into the default branch); never push to it.` : null,
    contractLine(input.contract),
    'Run the project setup in the worktree yourself (dependencies, build); Kawai runs no project commands.',
    input.guidance.trim() !== '' ? `Guidance: ${input.guidance.trim()}` : null,
    acceptance.text !== '' ? `Acceptance rules${acceptance.cut ? ' (cut — task_get has the rest)' : ''}:\n${acceptance.text}` : null,
    checks.text !== '' ? `Extra checks${checks.cut ? ' (cut — plan_get has the rest)' : ''}:\n${checks.text}` : null,
    `When the work is committed and the checks pass, submit your result with task_submit_result on task ${input.taskId} (commit and/or diff, tests, limitations). Attempt manifest: ${input.manifestHash}.`,
    'The plan, its validation report, and this task are the direction; ask the Lead group in a message if something is ambiguous.',
  ].filter(line => line !== null).join('\n\n')
}

export interface FixInstructionInput extends ImplementInstructionInput {
  failingChecks: Array<{ name: string; conclusion: string; link: string | null }>
  /** review-findings-ledger D7: the blocking findings rendered as lines, the others' count, and today's texts. */
  findings: { blocking: ReadonlyArray<{ id: string }>; blockingText: string; others: number; legacyTexts: string[] }
  fixRounds: number
  /** The execution's backstop (review-convergence decision 3). */
  fixRoundLimit: number
  /** A diagnosis decided with Fix round, Reject, or Reassign: the decision's rationale, which the fix carries. */
  diagnosis?: string | null
  continueFrom: string
}

/** D12's fix instruction: the failing checks, the blocking findings, the count, and the commit to continue from. */
export function fixInstruction(input: FixInstructionInput): string {
  const checks = input.failingChecks.map(check => `- ${check.name}: ${check.conclusion}${check.link ? ` (${check.link})` : ''}`).join('\n')
  const legacy = input.findings.legacyTexts.length > 0 ? input.findings.legacyTexts.join('\n---\n') : ''
  const { others } = input.findings
  const blockingCount = input.findings.blocking.length
  return [
    implementInstruction(input),
    '',
    `This is fix round ${input.fixRounds + 1} of ${input.fixRoundLimit}. Fix the failures below and submit a new result.`,
    input.diagnosis ? `The Lead diagnosed this change's review rounds and decided: ${input.diagnosis}` : null,
    `Failing checks:\n${checks || '- none reported'}`,
    blockingCount > 0 ? `Blocking findings to fix (task_get has each in full):\n${input.findings.blockingText}` : null,
    others > 0 ? `${others} other finding${others === 1 ? ' is' : 's are'} (advisory, unsupported, out of contract) in task_get; ${others === 1 ? 'it is' : 'they are'} not required.` : null,
    blockingCount > 0 ? 'Fix only the listed ids with minimal changes. If you can refute one with evidence, dispute it with task_dispute_findings instead of changing code.' : null,
    legacy !== '' ? `Review findings:\n${legacy.slice(0, LIST_CHARS)}${legacy.length > LIST_CHARS ? '\n…(cut — task_get has the rest)' : ''}` : null,
    `Continue from commit ${input.continueFrom}.`,
  ].filter(line => line !== null).join('\n')
}

/** The update attempt's instruction (D13): what failed and how to continue. The dispatch and the owed re-send build it from the manifest's `update` fact. */
export function updateInstruction(update: { base: string; files: string[] }): string {
  return [
    'Bring the branch up to date with the base branch.',
    update.files.length > 0
      ? `The merge conflicts with the base${update.base ? ` (base head ${update.base})` : ''} in: ${update.files.join(', ')}. Resolve the conflicts and commit the merge.`
      : `GitHub's branch update did not produce a clean merge. Merge the base branch yourself and push.`,
    'Then submit a new result with task_submit_result.',
  ].join('\n\n')
}

// The instruction texts Kawai dispatches (plan-execution D7, D11). The
// implement attempt tells the implementer where the worktree is, what the
// baseline and head are, what acceptance and extra checks gate the round,
// and to run the project's setup itself — Kawai runs no project commands.
// Long lists are cut at fixed limits with a pointer to `task_get` and
// `plan_get`, so an instruction never grows without bound (D7's risk).
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
  findings: string[]
  fixRounds: number
  continueFrom: string
}

/** D12's fix instruction: the failing checks, the findings, the count, and the commit to continue from. */
export function fixInstruction(input: FixInstructionInput): string {
  const checks = input.failingChecks.map(check => `- ${check.name}: ${check.conclusion}${check.link ? ` (${check.link})` : ''}`).join('\n')
  const findings = input.findings.length > 0 ? input.findings.join('\n---\n') : ''
  return [
    implementInstruction(input),
    '',
    `This is fix round ${input.fixRounds + 1} of 3. Fix the failures below and submit a new result.`,
    `Failing checks:\n${checks || '- none reported'}`,
    findings !== '' ? `Review findings:\n${findings.slice(0, LIST_CHARS)}${findings.length > LIST_CHARS ? '\n…(cut — task_get has the rest)' : ''}` : null,
    `Continue from commit ${input.continueFrom}.`,
  ].filter(line => line !== null).join('\n')
}

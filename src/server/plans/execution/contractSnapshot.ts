// The execution's contract snapshot (implementation-contract design D4,
// table E1–E5): before Kawai creates a change's task, it reads
// `openspec/changes/<change>/design.md` at the change's baseline commit —
// never the worktree, never later — and parses its `## Implementation
// contract` section. A contract becomes revision 1's; anything else creates
// the task without one and names the reason for the journal. Nothing here
// stops the change (validation refuses these cases for new executions, D5).
import { runGitAsync } from '../../git/gitCommand'
import { parseContract, type ImplementationContract } from '../../../shared/implementationContract'

/** `git show <rev>:<file>`: the text, the file missing at that commit, or a failure (timeout, spawn). */
export type ShowFile = (cwd: string, rev: string, file: string) => Promise<
  | { ok: true; text: string }
  | { ok: false; missing: true }
  | { ok: false; missing: false; error: string }
>

/** How many parser problems a journal line lists before counting the rest (E3). */
export const SNAPSHOT_PROBLEMS_LISTED = 5

/** git's answers for a path absent from a commit, as opposed to a failed command. */
const MISSING = /does not exist in|exists on disk, but not in/

export const gitShowFile: ShowFile = async (cwd, rev, file) => {
  const result = await runGitAsync(['show', `${rev}:${file}`], { cwd })
  if (result.ok) return { ok: true, text: result.stdout }
  if (MISSING.test(result.stderr)) return { ok: false, missing: true }
  return { ok: false, missing: false, error: (result.stderr || `exit ${result.exitCode ?? 'unknown'}`).trim() }
}

export interface ContractSnapshot {
  contract: ImplementationContract | null
  /** Why the task has no contract (E2–E5); null when it carries one (E1). */
  journal: string | null
}

export function designPath(change: string): string {
  return `openspec/changes/${change}/design.md`
}

/** Read and parse the change's contract at the baseline (E1–E5). */
export async function snapshotContract(show: ShowFile, cwd: string, baseline: string, change: string): Promise<ContractSnapshot> {
  const file = designPath(change)
  const at = baseline.slice(0, 7)
  const shown = await show(cwd, baseline, file)
  const none = (reason: string): ContractSnapshot => ({ contract: null, journal: `Created without an implementation contract: ${reason}.` })
  if (!shown.ok) return shown.missing ? none(`${file} missing at ${at}`) : none(`reading ${file} at ${at} failed (${shown.error})`)
  const parsed = parseContract(shown.text)
  if (parsed.contract) return { contract: parsed.contract, journal: null }
  const [first] = parsed.problems
  if (parsed.problems.length === 1 && first && /^No Implementation contract section/.test(first.message)) {
    return none(`no Implementation contract section in ${file} at ${at}`)
  }
  const listed = parsed.problems.slice(0, SNAPSHOT_PROBLEMS_LISTED).map(problem => `line ${problem.line}: ${problem.message}`).join('; ')
  return none(`the Implementation contract section in ${file} at ${at} does not parse (${parsed.problems.length} problem${parsed.problems.length === 1 ? '' : 's'}: ${listed}${parsed.problems.length > SNAPSHOT_PROBLEMS_LISTED ? '; …' : ''})`)
}

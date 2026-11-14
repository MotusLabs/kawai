// Headless contract consumer (task 1.2, oracle D09): uses only the package's
// public names, with no tools, context, audit or wire seams, and type-checks
// both factories against the frozen contract. Declared factories make this
// a compile-only fixture; examples/headless.ts is the runnable supervisor.
// The packed-artifact test compiles this file unchanged in a clean project
// with no Kawai sources.
import {
  type AgentDriver,
  type AgentEvent,
  type ClaudePermissions,
  type CodexPermissions,
  type CreateClaudeDriver,
  type CreateCodexDriver,
  type LaunchConfiguration,
  type Logger,
  type PendingRequest,
  type ProcessExitReceipt,
  type ResumeCheckpoint,
  type TurnResult,
} from '@motuslabs/agent-runtime'

declare const createClaudeDriver: CreateClaudeDriver
declare const createCodexDriver: CreateCodexDriver

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: (obj, msg) => console.error(msg ?? 'agent-runtime error', obj),
}

function launch(root: string, extraEnv: Record<string, string>): LaunchConfiguration {
  return {
    cwd: `${root}/work`,
    childEnv: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: `${root}/home`, ...extraEnv },
    homeDir: `${root}/home`,
    cacheDir: `${root}/cache`,
    tempDir: `${root}/tmp`,
  }
}

/** The restricted v1 profile: read tools only, Bash denied entirely. */
const restrictedClaude: ClaudePermissions = {
  mode: 'bypassPermissions',
  enabledTools: ['Read', 'Glob', 'Grep'],
  disallowedTools: ['AskUserQuestion', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'],
}

const headlessCodex: CodexPermissions = {
  approvalPolicy: 'never',
  sandbox: 'read-only',
  networkAccess: false,
  writableRoots: [],
  userInput: 'disabled',
  elicitation: 'disabled',
}

export async function runOnce(
  runtime: 'claude' | 'codex',
  root: string,
  saved: ResumeCheckpoint | undefined,
  persist: (checkpoint: ResumeCheckpoint) => Promise<void>,
): Promise<{ result: TurnResult; stop: ProcessExitReceipt }> {
  // Factories build an inert driver, so callbacks may reference it before start().
  let driver: AgentDriver | undefined
  const callbacks = {
    onEvent: (event: AgentEvent) => console.log(JSON.stringify({ type: event.type })),
    onRequest: (request: PendingRequest) => {
      if (request.kind === 'approval') driver?.resolveApproval(request.requestId, 'deny')
      else driver?.answerQuestion(request.requestId, {})
    },
    onCheckpoint: persist,
  }
  driver =
    runtime === 'claude'
      ? createClaudeDriver({
          logger,
          launch: launch(root, { CLAUDE_CODE_OAUTH_TOKEN: 'supplied-by-caller' }),
          callbacks,
          resume: saved,
          permissions: restrictedClaude,
        })
      : createCodexDriver({
          logger,
          launch: launch(root, { CODEX_HOME: `${root}/codex-home` }),
          callbacks,
          resume: saved,
          permissions: headlessCodex,
        })

  let result!: TurnResult
  let stop!: ProcessExitReceipt
  const failures: unknown[] = []
  try {
    await driver.start()
    const handle = await driver.send('Summarize README.md in one sentence.')
    result = await handle.result
  } catch (error) {
    failures.push(error)
  } finally {
    try {
      // Outside owner always awaits actual exit, also after start/send errors.
      stop = await driver.shutdown()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'run and stop failed')
  return { result, stop }
}

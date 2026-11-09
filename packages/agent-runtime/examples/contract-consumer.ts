// Headless contract consumer (task 1.2, oracle D09): uses only the package's
// public names, with no tools, context, audit or wire seams, and type-checks
// both factories against the frozen contract. It declares the factories
// instead of importing implementations, so it compiles before any driver
// moves. The packed-artifact test compiles this file unchanged in a clean
// project with no Kawai sources.
import {
  AgentRuntimeError,
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
    onEvent: (event: AgentEvent) => console.log(JSON.stringify(event)),
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

  try {
    await driver.start()
    const handle = await driver.send('Summarize README.md in one sentence.')
    const result = await handle.result
    const stop = await driver.shutdown()
    return { result, stop }
  } catch (error) {
    if (error instanceof AgentRuntimeError) logger.error(error.toJSON(), 'run failed')
    // Forced stop: resolves only after the owned processes actually exited.
    await driver.kill()
    throw error
  }
}

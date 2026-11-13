// Opt-in native acceptance host. Importing this module performs no I/O or live calls.
// Supply a private launch file prepared by the operator; never commit that file.
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { createClaudeDriver, RESTRICTED_CLAUDE_PERMISSIONS } from '@motuslabs/agent-runtime/claude'
import { createCodexDriver } from '@motuslabs/agent-runtime/codex'
import type { AgentCallbacks, AgentDriver, LaunchConfiguration, ProcessExitReceipt, ResumeCheckpoint, TurnResult } from '@motuslabs/agent-runtime'

export interface NativeInput {
  root: string
  runtime: 'claude' | 'codex'
  launch: LaunchConfiguration
  model: string
  /** Optional continuation after an independently recorded failed stop. */
  resume?: ResumeCheckpoint
  settings?: { env?: Readonly<Record<string, string>> }
}

/** Fail before provider construction if any writable runtime root escapes. */
export function validateIsolation(input: NativeInput, uid = process.getuid?.()): void {
  if (uid === undefined || uid === 0) throw new Error('native probe requires a non-root uid')
  if (!['claude', 'codex'].includes(input.runtime)) throw new Error('unknown runtime')
  const root = realpathSync(input.root)
  if (!isAbsolute(input.root) || root === '/' || (statSync(root).mode & 0o077) !== 0) throw new Error('probe root must be private')
  const { launch } = input
  const owned = (path: string | undefined) => {
    if (!path || !isAbsolute(path)) throw new Error('missing absolute isolated path')
    const rel = relative(root, realpathSync(path))
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('runtime path escapes probe root')
  }
  for (const path of [launch.cwd, launch.homeDir, launch.cacheDir, launch.tempDir,
    launch.childEnv.HOME, launch.childEnv.XDG_CACHE_HOME, launch.childEnv.TMPDIR,
    launch.childEnv.XDG_CONFIG_HOME, launch.childEnv.XDG_DATA_HOME,
    launch.childEnv.XDG_STATE_HOME,
    input.runtime === 'claude' ? launch.childEnv.CLAUDE_CONFIG_DIR : launch.childEnv.CODEX_HOME]) owned(path)
  if (!launch.executablePath || !isAbsolute(launch.executablePath)) throw new Error('explicit CLI required')
  if (!input.model) throw new Error('explicit configured model required')
}

/** The opt-in host must use the same explicit authority as its CLI child. */
export function validateHostIsolation(input: NativeInput, host = { cwd: process.cwd(), env: process.env }): void {
  validateIsolation(input)
  if (realpathSync(host.cwd) !== realpathSync(input.launch.cwd)) throw new Error('probe host cwd is not isolated')
  const actual = Object.entries(host.env).filter(([, value]) => value !== undefined).sort()
  const expected = Object.entries(input.launch.childEnv).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('probe host environment differs from explicit launch map')
}

export function verifyExit(receipt: ProcessExitReceipt, alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}): void {
  if (receipt.scope !== 'agent-processes' || receipt.js !== 'settled' || receipt.processes.length === 0) throw new Error('missing exit receipt')
  for (const fact of receipt.processes) {
    if (fact.state !== 'exited' || !fact.groupCleared || alive(fact.pid)) throw new Error('owned process not confirmed gone')
  }
}

const logger = { debug() {}, info() {}, warn() {}, error() {} }

/** Live work runs only when explicitly called, never under import or unit CI. */
export async function runNativeProbe(input: NativeInput): Promise<void> {
  validateHostIsolation(input)
  const { root, runtime, launch } = input
  const path = (name: string) => resolve(root, name)
  const raw: Record<string, unknown[]> = {}
  const record = (name: string, value: unknown) => {
    ;(raw[name] ??= []).push(value)
    writeFileSync(path(input.resume ? 'private-resume-evidence.json' : 'private-evidence.json'), JSON.stringify(raw, null, 2), { mode: 0o600 })
  }
  record('host', { pid: process.pid, uid: process.getuid?.(), cwd: process.cwd(), explicitEnvironmentVerified: true })
  let checkpoint: ResumeCheckpoint | undefined = input.resume
  let operation = 'construct'
  let driver: AgentDriver | undefined
  let assistant: (() => void) | undefined
  const callbacks: AgentCallbacks = {
    onEvent(event) {
      record('events', event)
      if (event.type === 'assistant_text' || event.type === 'assistant_delta') assistant?.()
    },
    onCheckpoint(value) { checkpoint = value; record('checkpoints', value) },
    onState: (value) => record('states', value),
    onSpawn: (value) => record('spawns', value),
    onTurnResult: (value) => record('results', value),
    onProcessEnd: (value) => record('processEnds', value),
    onModel: (value) => record('models', value),
    onContextUsage: (value) => record('context', value),
    onLimitEvent: (value) => record('limits', value),
    onQuotaReport: (value) => record('quota', value),
    onQuotaNoData: (value) => record('quotaNoData', value),
    onCompaction: (value) => record('compaction', value),
    onRequest(request) {
      record('requests', { kind: request.kind, id: request.requestId })
      if (request.kind === 'approval') record('denials', driver?.resolveApproval(request.requestId, 'deny'))
    },
  }
  const build = (resume?: ResumeCheckpoint) => {
    const base = { launch, logger, callbacks, model: input.model, ...(resume ? { resume } : {}),
      wire: { record: (frame: unknown) => record('wire', frame) } }
    return runtime === 'claude'
      ? createClaudeDriver({ ...base, permissions: RESTRICTED_CLAUDE_PERMISSIONS,
        settingSources: [], settings: input.settings, quotaSource: 'none',
        auditHooks: { onHook: (value) => record('hooks', value) } })
      : createCodexDriver({ ...base,
        permissions: { approvalPolicy: 'never', sandbox: resume ? 'read-only' : 'workspace-write',
          networkAccess: false, writableRoots: [], userInput: 'disabled', elicitation: 'disabled' },
        onThreadOpened: (value) => record('threads', value) })
  }
  const turn = async (text: string): Promise<TurnResult> => {
    operation = 'turn'
    const handle = await driver!.send(text)
    return handle.result
  }
  writeFileSync(resolve(launch.cwd, 'read-marker.txt'), 'native-read-cobalt\n', { mode: 0o600 })
  try {
    let saved = input.resume
    if (!saved) {
      driver = build()
      operation = 'initial-start'
      await driver.start()
      const first = await turn('Read read-marker.txt using a tool. Remember the phrase cobalt-otter-73 in this conversation. '
        + (runtime === 'claude' ? 'Try Bash to write denied.txt containing DENIED, once; if unavailable report that. ' : 'Write allowed.txt containing ALLOWED using a tool. ')
        + 'Reply briefly with the remembered phrase and tool outcomes.')
      record('first', first)
      if (first.outcome !== 'success' || !checkpoint) throw new Error('initial native turn or checkpoint missing')
      saved = { ...checkpoint }
      const observed = new Promise<void>((resolve) => { assistant = resolve })
      const handle = await driver.send('Print all integers from 1 through 10000, one per line. Start immediately.')
      const boundary = await Promise.race([observed.then(() => 'assistant'), handle.result.then(() => 'finished')])
      assistant = undefined
      record('interruptBoundary', boundary)
      operation = 'interrupt'
      record('interrupt', await driver.interrupt())
      record('interruptedResult', await handle.result)
      operation = 'kill'
      const killed = await driver.kill()
      record('kill', killed)
      verifyExit(killed)
      record('killVerified', true)
    }
    driver = build(saved)
    operation = 'resume-start'
    await driver.start()
    const resumed = await turn('What phrase did I ask you to remember earlier? Do not read any files to recall it. '
      + 'Try once to write denied-resume.txt containing DENIED using a tool, then briefly report the phrase and outcome.')
    record('resumed', resumed)
    record('sameIdentity', checkpoint?.runtimeSessionId === saved.runtimeSessionId)
    operation = 'shutdown'
    const ended = await driver.shutdown()
    record('shutdown', ended)
    verifyExit(ended)
    record('shutdownVerified', true)
    record('sentinels', { initialDenied: existsSync(resolve(launch.cwd, 'denied.txt')),
      resumedDenied: existsSync(resolve(launch.cwd, 'denied-resume.txt')),
      initialAllowed: existsSync(resolve(launch.cwd, 'allowed.txt')) })
  } catch (error) {
    // Private failures can contain provider data. Never echo them to stdout.
    record('failure', { operation, error: privateError(error) })
    if (driver) {
      try { record('cleanup', await driver.kill()) } catch (stop) {
        record('cleanupFailure', privateError(stop))
      }
    }
    throw new Error('native probe incomplete; inspect private evidence')
  }
}

/** Private-only recursive error data, including non-enumerable native causes. */
export function privateError(error: unknown, seen = new WeakSet<object>()): unknown {
  if (error === null || typeof error !== 'object') return typeof error === 'bigint' ? String(error) : error
  if (seen.has(error)) return { circularReference: true }
  seen.add(error)
  if (Array.isArray(error)) return error.map((value) => privateError(value, seen))
  const value: Record<string, unknown> = {}
  if (error instanceof Error) { value.name = error.name; value.message = error.message; value.stack = error.stack }
  for (const key of Object.getOwnPropertyNames(error)) {
    value[key] = privateError((error as Record<string, unknown>)[key], seen)
  }
  return value
}

if (import.meta.main) {
  if (process.argv[2] !== '--run' || !process.argv[3]) throw new Error('explicit --run <private-input.json> required')
  const config = resolve(process.argv[3])
  if ((statSync(config).mode & 0o077) !== 0) throw new Error('launch file must be private')
  await runNativeProbe(JSON.parse(readFileSync(config, 'utf8')) as NativeInput)
}

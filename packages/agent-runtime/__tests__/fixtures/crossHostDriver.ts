// One host process for the cross-host correlation test (task 4.4, batch B
// U3): it builds the public driver of the runtime it is given (Claude or
// Codex), persists every checkpoint to the caller's file store (a temporary
// file, then a rename), resumes from that store when asked, sends the prompts
// in order and awaits each result, then stops with an awaited kill or
// shutdown. It prints one JSON line: its own pid, every handle, result and
// onTurnResult callback with their ids, the checkpoints, the stored identity,
// the stop receipt's processes and every onProcessEnd report. Nothing is
// shared with any other host but the retained homes and the store.
//   argv: <JSON HostConfig>
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createClaudeDriver } from '../../src/claude/index.js'
import { createCodexDriver } from '../../src/codex/index.js'
import type { AgentDriver, ProcessEndReport, ResumeCheckpoint, TurnResult } from '../../src/contract.js'
import type { LaunchConfiguration } from '../../src/options.js'

interface HostConfig {
  runtime: 'claude' | 'codex'
  launch: LaunchConfiguration
  store: string
  resume: boolean
  prompts: string[]
  stop: 'kill' | 'shutdown'
}

const config = JSON.parse(process.argv[2]!) as HostConfig
const silent = () => {}
const logger = { debug: silent, info: silent, warn: silent, error: silent }
const checkpoints: ResumeCheckpoint[] = []
const callbacks: Array<{ turnId: string; messageUuid: string | null; outcome: string }> = []
const ends: ProcessEndReport[] = []
const resume: ResumeCheckpoint | undefined = config.resume ? (JSON.parse(readFileSync(config.store, 'utf8')) as ResumeCheckpoint) : undefined
const hooks = {
  onEvent: silent,
  onProcessEnd: (report: ProcessEndReport) => void ends.push(report),
  onTurnResult: (result: TurnResult) => void callbacks.push({ turnId: result.turnId, messageUuid: result.messageUuid, outcome: result.outcome }),
  onCheckpoint: (checkpoint: ResumeCheckpoint) => {
    checkpoints.push(checkpoint)
    writeFileSync(`${config.store}.tmp`, JSON.stringify(checkpoint))
    renameSync(`${config.store}.tmp`, config.store)
  },
}
const driver: AgentDriver = config.runtime === 'claude'
  ? createClaudeDriver({ launch: config.launch, logger, permissions: { mode: 'default', enabledTools: ['Read'], disallowedTools: [] }, callbacks: hooks, ...(resume ? { resume } : {}) })
  : createCodexDriver({
    launch: config.launch,
    logger,
    permissions: { approvalPolicy: 'never', sandbox: 'read-only', networkAccess: false, writableRoots: [], userInput: 'disabled', elicitation: 'disabled' },
    callbacks: hooks,
    ...(resume ? { resume } : {}),
  })

// Every path after construction attempts the awaited stop in finally, and a
// failure anywhere (start, send, result, stop, the store read) is kept raw
// in the report and makes the host exit nonzero.
const failures: string[] = []
/** `category: message`, then each raw cause in order after ` <= `, recursively. */
const describe = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  const causes = (error as { causes?: readonly unknown[] }).causes ?? []
  const head = `${(error as { category?: string }).category ?? error.name}: ${error.message}`
  return causes.length > 0 ? `${head} <= [${causes.map(describe).join(' ; ')}]` : head
}
const keep = (error: unknown) => void failures.push(describe(error))
const handles: Array<{ turnId: string; messageUuid: string }> = []
const results: Array<{ turnId: string; messageUuid: string | null; outcome: string; finalText: string | null }> = []
let receipt: { mode: string; processes: Array<{ state: string; pid?: number }> } | null = null
try {
  await driver.start()
  for (const prompt of config.prompts) {
    const handle = await driver.send(prompt)
    handles.push({ turnId: handle.turnId, messageUuid: handle.messageUuid })
    const result = await handle.result
    results.push({ turnId: result.turnId, messageUuid: result.messageUuid, outcome: result.outcome, finalText: result.finalText })
  }
} catch (error) {
  keep(error)
} finally {
  try {
    const stopped = await (config.stop === 'kill' ? driver.kill() : driver.shutdown())
    receipt = { mode: stopped.mode, processes: stopped.processes.map((p) => ({ state: p.state, ...('pid' in p ? { pid: p.pid } : {}) })) }
  } catch (error) {
    keep(error)
  }
}
let stored: unknown = null
try {
  stored = existsSync(config.store) ? JSON.parse(readFileSync(config.store, 'utf8')) : null
} catch (error) {
  keep(error)
}
const report = { pid: process.pid, resumed: resume ?? null, handles, results, callbacks, checkpoints, stored, receipt, ends, failures }
process.stdout.write(`${JSON.stringify(report)}\n`)
process.exitCode = failures.length > 0 ? 1 : 0

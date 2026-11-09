// One host process for the cross-process resume tests (task 4.4, Claude
// unit). It builds a driver through the public factory with the launch it is
// given, persists every checkpoint to the caller's own file store (written to
// a temporary file, then renamed), optionally resumes from that store, sends
// the prompts in order, awaits each result, then stops with kill or shutdown.
// A store may reject every checkpoint (it records the offer, writes nothing
// and throws), and the caller may resume an identity it already holds
// instead of the store's.
// It prints one JSON line to stdout describing what it observed, and exits.
// Nothing is shared with any other host but the files under the retained
// homes and the store.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createClaudeDriver } from '../../src/claude/index.js'
import type { ResumeCheckpoint } from '../../src/contract.js'
import type { LaunchConfiguration } from '../../src/options.js'

interface HostConfig {
  launch: LaunchConfiguration
  /** The caller's checkpoint store. */
  store: string
  /** Resume the conversation the store holds. */
  resume: boolean
  /** Resume this caller-held identity instead of the store's. */
  resumeId?: string
  /** The store refuses every checkpoint. */
  rejectCheckpoint?: boolean
  prompts: string[]
  stop: 'kill' | 'shutdown'
}

const config = JSON.parse(process.argv[2]!) as HostConfig
const checkpoints: ResumeCheckpoint[] = []
const silent = () => {}
const error = (e: unknown) => {
  const failure = e as { category?: string; message?: string }
  return { category: failure.category ?? null, message: failure.message ?? String(e) }
}
const resume: ResumeCheckpoint | undefined = config.resumeId !== undefined ? { runtime: 'claude', runtimeSessionId: config.resumeId }
  : config.resume ? (JSON.parse(readFileSync(config.store, 'utf8')) as ResumeCheckpoint) : undefined
const driver = createClaudeDriver({
  launch: config.launch,
  logger: { debug: silent, info: silent, warn: silent, error: silent },
  permissions: { mode: 'default', enabledTools: ['Read'], disallowedTools: [] },
  callbacks: {
    onEvent: silent,
    onCheckpoint: (checkpoint) => {
      checkpoints.push(checkpoint)
      if (config.rejectCheckpoint) throw new Error('the caller store refused the checkpoint')
      writeFileSync(`${config.store}.tmp`, JSON.stringify(checkpoint))
      renameSync(`${config.store}.tmp`, config.store)
    },
  },
  ...(resume ? { resume } : {}),
})

const report: Record<string, unknown> = { pid: process.pid, resumed: resume ?? null }
try {
  await driver.start()
  report.start = 'ok'
  const results = []
  for (const prompt of config.prompts) {
    const handle = await driver.send(prompt)
    const result = await handle.result
    results.push({ outcome: result.outcome, finalText: result.finalText, ...(result.error ? { error: result.error.category } : {}) })
  }
  report.results = results
} catch (e) {
  report.start = error(e)
}
report.checkpoints = checkpoints
report.stored = existsSync(config.store) ? JSON.parse(readFileSync(config.store, 'utf8')) : null
try {
  const receipt = await (config.stop === 'kill' ? driver.kill() : driver.shutdown())
  report.stop = { mode: receipt.mode, processes: receipt.processes.length }
} catch (e) {
  report.stop = error(e)
}
process.stdout.write(`${JSON.stringify(report)}\n`)

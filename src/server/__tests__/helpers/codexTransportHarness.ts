// Test-only boundary from the retired root AppServerClient's cases to the
// package's AppServerTransport (extract-agent-runtime 6.2/6.3, task-d52b6709).
// It only maps calls and data: an explicit launch (cwd = the owned root, the
// child's complete env exactly as the old case gave it), the command and the
// default `app-server` argv, clientInfo/capabilities at construction, the
// old {dir, line} view of the package's wire frames, and the old kill grace
// as the stop's graceMs. Buffering, correlation, deadlines, drain, process
// ownership and stop all stay the transport's own.
//
// Cleanup joins before it removes: it awaits every transport's shared stop
// (the leader's actual exit, an empty group, every handler job joined), then
// removes the root in finally. Overlapping cleanups share one promise. A stop
// failure the test did not take itself (case.stop()) rejects the cleanup with
// that failure once, by identity; a taken stop's outcome is the test's.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AppServerTransport,
  type AppServerClientInfo,
  type AppServerTransportOptions,
} from '../../../../packages/agent-runtime/src/codex/appServerTransport'
import type { ProcessExitFact } from '../../../../packages/agent-runtime/src/contract'
import type { JsonObject } from '../../../../packages/agent-runtime/src/json'
import { resolveLaunch } from '../../../../packages/agent-runtime/src/process/launch'
import type { LeaderExit } from '../../../../packages/agent-runtime/src/process/ownedProcess'

export interface RecordedFrame {
  dir: string
  line: string
}

export interface TransportCaseInput {
  executable: string
  /** The child's complete environment, exactly as the old case built it. */
  env: Record<string, string>
  clientInfo: AppServerClientInfo
  capabilities: JsonObject
  /** Record the wire (default true); the replay cases recorded nothing. */
  record?: boolean
  onServerRequest?: AppServerTransportOptions['onServerRequest']
  /** The old killGraceMs: SIGTERM -> SIGKILL escalation delay. */
  graceMs?: number
  requestTimeoutMs?: number
  drainBoundMs?: number
}

export interface TransportCase {
  transport: AppServerTransport
  frames: RecordedFrame[]
  notifications: Array<{ method: string; params: JsonObject }>
  /** Every unsolicited exit the transport reported through onExit. */
  exits: LeaderExit[]
  /** Resolves with the first exit the transport reports through onExit. */
  reportedExit: Promise<LeaderExit>
  /** The transport's shared stop; calling it hands its outcome to the caller. */
  stop(): Promise<ProcessExitFact>
}

export interface TransportCases {
  /** The owned temp root; every launch dir lives under it. */
  root: string
  open(input: TransportCaseInput): TransportCase
  cleanup(): Promise<void>
}

export function transportCases(prefix: string): TransportCases {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const opened: Array<{ transport: AppServerTransport; taken: boolean }> = []
  let cleaning: Promise<void> | null = null

  const open = (input: TransportCaseInput): TransportCase => {
    const dirs = ['home', 'cache', 'tmp'].map((name) => path.join(root, `${name}-${opened.length + 1}`))
    for (const dir of dirs) fs.mkdirSync(dir)
    const [homeDir, cacheDir, tempDir] = dirs as [string, string, string]
    const frames: RecordedFrame[] = []
    const notifications: TransportCase['notifications'] = []
    const exits: LeaderExit[] = []
    let reported!: (exit: LeaderExit) => void
    const reportedExit = new Promise<LeaderExit>((resolve) => (reported = resolve))
    const transport = new AppServerTransport({
      launch: resolveLaunch({ cwd: root, childEnv: input.env, homeDir, cacheDir, tempDir }),
      generation: 1,
      command: input.executable,
      clientInfo: input.clientInfo,
      capabilities: input.capabilities,
      ...(input.record === false ? {} : { wire: { record: (frame) => frames.push({ dir: frame.direction, line: frame.text }) } }),
      onNotification: (method, params) => notifications.push({ method, params }),
      ...(input.onServerRequest ? { onServerRequest: input.onServerRequest } : {}),
      onExit: (exit) => {
        exits.push(exit)
        reported(exit)
      },
      ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
      ...(input.drainBoundMs !== undefined ? { drainBoundMs: input.drainBoundMs } : {}),
      ...(input.graceMs !== undefined ? { terminate: { graceMs: input.graceMs } } : {}),
    })
    const entry = { transport, taken: false }
    opened.push(entry)
    transport.start()
    return {
      transport,
      frames,
      notifications,
      exits,
      reportedExit,
      stop: () => {
        entry.taken = true
        return transport.stop()
      },
    }
  }

  const cleanup = (): Promise<void> => {
    cleaning ??= (async () => {
      const outcomes = await Promise.allSettled(opened.map((entry) => entry.transport.stop()))
      try {
        const failures = outcomes.flatMap((outcome, index) =>
          outcome.status === 'rejected' && !opened[index]!.taken ? [outcome.reason as unknown] : [])
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'transport stops failed')
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })()
    return cleaning
  }

  return { root, open, cleanup }
}

// Test-only boundary from the retired root AppServerClient's cases to the
// package's AppServerTransport (extract-agent-runtime 6.2/6.3, task-d52b6709).
// It only maps calls and data: an explicit launch (cwd = the test process's
// own cwd captured at launch, which the old client's child inherited; the
// child's complete env exactly as the old case gave it; the owned temp root
// holds only the launch's home/cache/temp resources), the command and the
// default `app-server` argv, clientInfo/capabilities at construction, the
// old {dir, line} view of the package's wire frames, and the old kill grace
// as the stop's graceMs. Buffering, correlation, deadlines, drain, process
// ownership and stop all stay the transport's own.
//
// Cleanup joins before it removes: it awaits every transport's shared stop
// (the leader's actual exit, an empty group, every handler job joined), then
// removes the root in finally. Overlapping cleanups share one promise. A stop
// failure rejects the cleanup with that failure once, by identity, unless the
// test explicitly took that exact rejection through case.stopFailure().
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

/** One observation in the order the test saw it: a recorded wire frame or an onExit report. */
export type TimelineEntry = ({ kind: 'frame' } & RecordedFrame) | { kind: 'onExit'; exit: LeaderExit }

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
  /** Recorded frames and onExit reports, interleaved in the order they happened. */
  timeline: TimelineEntry[]
  notifications: Array<{ method: string; params: JsonObject }>
  /** Every unsolicited exit the transport reported through onExit. */
  exits: LeaderExit[]
  /** Resolves with the first exit the transport reports through onExit. */
  reportedExit: Promise<LeaderExit>
  /** The transport's shared stop (one terminal promise for every caller). */
  stop(): Promise<ProcessExitFact>
  /**
   * The shared stop's rejection, for a test that asserts it: that exact
   * rejection is then not reported again by cleanup. Throws when the stop resolves.
   */
  stopFailure(): Promise<unknown>
}

export interface TransportCases {
  /** The owned temp root; every launch dir lives under it. */
  root: string
  open(input: TransportCaseInput): TransportCase
  cleanup(): Promise<void>
}

export function transportCases(prefix: string): TransportCases {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const opened: Array<{ transport: AppServerTransport; asserted: { error: unknown } | null }> = []
  let cleaning: Promise<void> | null = null

  const open = (input: TransportCaseInput): TransportCase => {
    const dirs = ['home', 'cache', 'tmp'].map((name) => path.join(root, `${name}-${opened.length + 1}`))
    for (const dir of dirs) fs.mkdirSync(dir)
    const [homeDir, cacheDir, tempDir] = dirs as [string, string, string]
    const frames: RecordedFrame[] = []
    const timeline: TimelineEntry[] = []
    const notifications: TransportCase['notifications'] = []
    const exits: LeaderExit[] = []
    let reported!: (exit: LeaderExit) => void
    const reportedExit = new Promise<LeaderExit>((resolve) => (reported = resolve))
    const transport = new AppServerTransport({
      launch: resolveLaunch({ cwd: process.cwd(), childEnv: input.env, homeDir, cacheDir, tempDir }),
      generation: 1,
      command: input.executable,
      clientInfo: input.clientInfo,
      capabilities: input.capabilities,
      ...(input.record === false ? {} : {
        wire: {
          record: (frame) => {
            const recorded = { dir: frame.direction, line: frame.text }
            frames.push(recorded)
            timeline.push({ kind: 'frame', ...recorded })
          },
        },
      }),
      onNotification: (method, params) => notifications.push({ method, params }),
      ...(input.onServerRequest ? { onServerRequest: input.onServerRequest } : {}),
      onExit: (exit) => {
        exits.push(exit)
        timeline.push({ kind: 'onExit', exit })
        reported(exit)
      },
      ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
      ...(input.drainBoundMs !== undefined ? { drainBoundMs: input.drainBoundMs } : {}),
      ...(input.graceMs !== undefined ? { terminate: { graceMs: input.graceMs } } : {}),
    })
    const entry: (typeof opened)[number] = { transport, asserted: null }
    opened.push(entry)
    transport.start()
    return {
      transport,
      frames,
      timeline,
      notifications,
      exits,
      reportedExit,
      stop: () => transport.stop(),
      stopFailure: async () => {
        try {
          await transport.stop()
        } catch (error) {
          entry.asserted = { error }
          return error
        }
        throw new Error('expected the transport stop to fail')
      },
    }
  }

  const cleanup = (): Promise<void> => {
    cleaning ??= (async () => {
      const outcomes = await Promise.allSettled(opened.map((entry) => entry.transport.stop()))
      try {
        const failures = outcomes.flatMap((outcome, index) =>
          outcome.status === 'rejected' && opened[index]!.asserted?.error !== outcome.reason ? [outcome.reason as unknown] : [])
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

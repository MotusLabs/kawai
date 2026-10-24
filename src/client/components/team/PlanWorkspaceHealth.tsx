// The workspace's agent health dots (plan-workspace 5.4, design D5): the
// snapshot's passive readings, recombined on a client clock at least once a
// minute through the shared derivation. The dot is compact and explainable —
// a keyboard-accessible disclosure carries both readings' values, sources,
// timestamps, resets, and their approximation; a disconnected workspace
// reads unknown regardless of age; partial facts stay visible even when the
// combined dot is gray. The dot never predicts failure or controls dispatch.
import { useEffect, useState } from 'react'
import type { WorkspaceAgentHealth, WorkspaceAgentReading, WorkspaceHealthLevel } from '@shared/planWorkspace'
import { contextLevelOf, quotaLevelOf, workspaceHealthOf } from '@shared/planWorkspaceHealth'
import { shortHash } from '../chat/strategyLabels'

const DOT_CLASS: Record<WorkspaceHealthLevel, string> = {
  green: 'bg-approval',
  yellow: 'bg-warning',
  red: 'bg-chat-danger',
  unknown: 'bg-border',
}

const LEVEL_WORDS: Record<WorkspaceHealthLevel, string> = {
  green: 'healthy', yellow: 'pressure', red: 'critical', unknown: 'unknown',
}

export function healthAriaLabel(health: WorkspaceAgentHealth, now: Date): string {
  const context = contextLevelOf(health.context, now)
  const quota = quotaLevelOf(health.quota, now)
  return `Health ${LEVEL_WORDS[health.level]}: context ${context}${describe(health.context)}; quota ${quota}${describe(health.quota)}`
}

const describe = (reading: { used: number | null } | null): string =>
  reading === null ? ' (no reading)' : ` (${share(reading.used)})`

const share = (used: number | null): string =>
  used === null ? 'not reported' : `${Math.round(used * 100)}%`

const when = (at: string | null): string =>
  at === null ? 'never' : new Date(at).toLocaleString()

/** One agent's dot and its disclosure; recompute rides the parent's clock tick. */
export function WorkspaceHealthDot({ reading, connected, now }: {
  reading: WorkspaceAgentReading
  connected: boolean
  now: Date
}) {
  const health: WorkspaceAgentHealth = workspaceHealthOf(
    { context: reading.context, quota: reading.quota, quotaApplicable: reading.quotaApplicable, connected },
    now,
  )
  return <details className="inline-block" data-testid={`workspace-health-${reading.sessionId}`}>
    <summary className="flex cursor-pointer items-center gap-1" aria-label={healthAriaLabel(health, now)}>
      <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-full ${DOT_CLASS[health.level]}`}
        data-testid={`workspace-health-dot-${reading.sessionId}`} data-level={health.level} />
      <span className="text-chat-meta text-secondary">{reading.name ?? shortHash(reading.sessionId)}</span>
    </summary>
    <div className="mt-1 border border-border p-2 text-chat-meta" data-testid={`workspace-health-detail-${reading.sessionId}`}>
      <p>Context: {reading.context === null ? 'no reading' : `${share(reading.context.used)} used, measured ${when(reading.context.measuredAt)}`} (approximate thresholds)</p>
      {reading.quota === null
        ? <p>Quota: no reading</p>
        : <p>Quota: {share(reading.quota.used)} used, status {reading.quota.status ?? 'unknown'}, source {reading.quota.source}
          {reading.quota.source === 'account' && ' (the host account’s allowance — not this provider’s)'}
          {reading.quota.source !== 'account' && ' (shared by profile)'}
          {reading.quota.resetsAt !== null ? `, resets ${when(reading.quota.resetsAt)}` : ''}, measured {when(reading.quota.measuredAt)}
        </p>}
      {!reading.quotaApplicable && reading.quota !== null && <p className="text-approval">This quota reading is excluded from the combined indicator: routing to a gateway provider is unconfirmed.</p>}
      {!connected && <p className="text-approval">Disconnected — readings are stale until the connection returns.</p>}
    </div>
  </details>
}

/** The health list for the exposed agents, on a one-minute client clock (design D5). */
export default function PlanWorkspaceHealth({ readings, connected }: {
  readings: WorkspaceAgentReading[]
  connected: boolean
}) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [])
  if (readings.length === 0) {
    return <p className="mt-2 text-chat-meta text-secondary" data-testid="workspace-health-empty">
      No assigned agents to show health for.
    </p>
  }
  return <div data-testid="plan-workspace-health" className="mt-2">
    <h4 className="font-medium">Agent health</h4>
    <ul className="mt-1 flex flex-wrap gap-3">
      {readings.map(reading => <li key={reading.sessionId}>
        <WorkspaceHealthDot reading={reading} connected={connected} now={now} />
      </li>)}
    </ul>
  </div>
}

// The worker picker of the human dispatch forms (dispatch-worker-choice 4.3):
// for a group target only, the group's workers grouped by provider — each
// provider's usage and cooldown, each model's live count, cap, and cooldown —
// from the same TeamCapacity answer the `team_capacity` tool gives
// (`team-task-capacity`). The value is a provider id or `provider/model`, ''
// for any worker; the server normalizes and validates it at dispatch. The
// answer holds ids, counts, usage windows, and times only (I5).
import { useEffect, useRef } from 'react'
import type { SendClientMessage } from '@shared/types'
import type { CapacityGroup, CapacityProvider, CapacityWorker } from '@shared/teamCapacity'
import { useTeamTaskStore } from '../../stores/teamTaskStore'

const time = (iso: string) => new Date(iso).toLocaleString()

export const usageText = (provider: CapacityProvider | undefined) => {
  if (!provider?.usage) return 'usage unknown'
  const windows = provider.usage.windows.map(window => `${window.key} ${Math.round(window.percentUsed)}%`).join(', ')
  return `${provider.usage.status}${windows ? ` (${windows})` : ''}`
}

const workerText = (worker: CapacityWorker) => [
  worker.model,
  `${worker.live}${worker.cap === null ? '' : `/${worker.cap}`} live`,
  ...(worker.cooldownUntil ? [`${worker.credit ? 'out of credit' : 'cooling'} until ${time(worker.cooldownUntil)}`] : []),
].join(' · ')

/** The group's workers by provider, in the group's preference order. */
export function workersByProvider(group: CapacityGroup): Array<{ provider: string; workers: CapacityWorker[] }> {
  const byProvider = new Map<string, CapacityWorker[]>()
  for (const worker of group.workers) byProvider.set(worker.provider, [...(byProvider.get(worker.provider) ?? []), worker])
  return [...byProvider].map(([provider, workers]) => ({ provider, workers }))
}

export function TaskWorkerPicker({ teamPath, group, value, onChange, sendMessage, connected, disabled, label = 'Worker', testId }: {
  teamPath: string
  /** The chosen group target; nothing renders without one. */
  group: string
  value: string
  onChange: (worker: string) => void
  sendMessage: SendClientMessage
  connected: boolean
  disabled?: boolean
  /** Prefix of the select's accessible name. */
  label?: string
  testId: string
}) {
  const capacity = useTeamTaskStore(state => state.views[teamPath]?.capacity ?? null)
  // A host may pass a fresh sendMessage each render; only its latest is used.
  const send = useRef(sendMessage)
  send.current = sendMessage
  // Re-read whenever the team, the group, or the connection changes: counts
  // and cooldowns move, and a team switch must never show another team's.
  useEffect(() => {
    if (!connected || !group) return
    send.current({ type: 'team-task-capacity', teamPath, requestId: crypto.randomUUID() })
  }, [teamPath, group, connected])
  if (!group) return null
  const counted = capacity?.groups.find(candidate => candidate.id === group)
  const providers = new Map((capacity?.providers ?? []).map(provider => [provider.id, provider]))
  const grouped = counted ? workersByProvider(counted) : []
  const providerName = (id: string) => providers.get(id)?.label ?? id
  return <div className="flex flex-col gap-1" data-testid={testId}>
    <select className="input text-chat-body" aria-label={`${label} worker`} value={value} disabled={disabled}
      onChange={event => onChange(event.target.value)}>
      <option value="">Any worker (the group's routing decides)</option>
      {grouped.map(({ provider, workers }) => <optgroup key={provider} label={`${providerName(provider)} — ${usageText(providers.get(provider))}`}>
        <option value={provider}>Any model of {providerName(provider)}</option>
        {workers.map(worker => <option key={worker.model} value={`${provider}/${worker.model}`}>{workerText(worker)}</option>)}
      </optgroup>)}
    </select>
    {grouped.length > 0 && <ul className="text-chat-meta text-secondary" data-testid={`${testId}-providers`}>
      {grouped.map(({ provider }) => {
        const facts = providers.get(provider)
        return <li key={provider} data-testid={`${testId}-provider-${provider}`}>
          {providerName(provider)}: {usageText(facts)}
          {facts?.cooldownUntil ? ` · cooling until ${time(facts.cooldownUntil)}` : ''}
        </li>
      })}
    </ul>}
    {!counted && <p className="text-chat-meta text-secondary">{capacity ? 'This group lists no workers.' : 'Loading workers…'}</p>}
    <p className="text-chat-meta text-secondary">A chosen worker waits for its cooldown and caps rather than going elsewhere.</p>
  </div>
}

// The activity row (design D6): one muted, pulsing line at the end of the
// transcript naming what the in-flight turn is doing and for how long. The
// elapsed time ticks once per second of the phase's age on the client clock —
// no server traffic — and its timer lives only while the row is mounted. Hiding the row
// (responding phase, pending requests, archived chats) is ChatView's decision
// (design D4); this component only renders what it is given.
import { useEffect, useState } from 'react'
import type { ChatActivity } from '@shared/chat'
import { formatElapsed } from './chatElapsed'

/** Human label for a phase; tools fall back to a generic name. */
function activityLabel(activity: ChatActivity): string {
  switch (activity.phase) {
    case 'requesting':
      return 'Waiting for model…'
    case 'thinking':
      return 'Thinking…'
    case 'responding':
      return 'Responding…'
    case 'preparing_tool':
      return `Writing ${activity.tool ?? 'tool'} input…`
    case 'running_tools':
      return (activity.count ?? 1) > 1
        ? `Running ${activity.count} tools…`
        : `Running ${activity.tool ?? 'tool'}…`
    case 'retrying': {
      const attempt = `${activity.attempt ?? '?'}/${activity.maxRetries ?? '?'}`
      return typeof activity.errorStatus === 'number'
        ? `Retrying (${attempt}, ${activity.errorStatus})…`
        : `Retrying (${attempt})…`
    }
  }
}

export default function ChatActivityRow({ activity, phaseStartedAt }: {
  activity: ChatActivity
  /** Client-clock anchor from the store (Date.now() - elapsedMs on arrival). */
  phaseStartedAt: number
}) {
  const [now, setNow] = useState(() => Date.now())
  // One timeout chain per anchor, each step landing on the next whole second
  // of the phase's age: a phase that re-anchors on the mounted row (requesting
  // -> thinking) or arrives already aged ticks on its own seconds, not on the
  // mount's. A new anchor or unmount clears the pending step.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const step = () => {
      const current = Date.now()
      setNow(current)
      const intoSecond = (((current - phaseStartedAt) % 1000) + 1000) % 1000
      timer = setTimeout(step, 1000 - intoSecond)
    }
    step()
    return () => clearTimeout(timer)
  }, [phaseStartedAt])
  return (
    <p className="flex items-center gap-2 text-chat-meta text-secondary" data-testid="chat-activity" data-phase={activity.phase}>
      <span className="chat-activity-dot" aria-hidden="true" />
      <span>{activityLabel(activity)}</span>
      <span data-testid="chat-activity-elapsed">{formatElapsed(now - phaseStartedAt)}</span>
    </p>
  )
}

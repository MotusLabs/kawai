// Hand off a parked message (profile routing): forward it, with a handoff
// package, to a group or session the human chooses, whatever the rule
// decided; the parked agent's resume is cancelled server-side.
import { useState } from 'react'
import type { SendClientMessage } from '@shared/types'
import type { HandOffResult } from '../../stores/teamMailboxStore'

export default function ParkedHandOff({ sessionId, messageId, groups, sendMessage, disabled, result }: {
  sessionId: string
  messageId: string
  /** Group ids of the team, offered as suggestions. */
  groups: string[]
  sendMessage: SendClientMessage
  disabled: boolean
  result?: HandOffResult
}) {
  const [kind, setKind] = useState<'group' | 'session'>('group')
  const [target, setTarget] = useState('')
  const listId = `handoff-groups-${messageId}`
  const send = () => sendMessage({ type: 'team-mailbox-hand-off', sessionId, messageId, target: { kind, id: target.trim() } })
  // `.input` is full width: the kind picker takes its own line, the target
  // and the button share the next one.
  return <div className="mt-2 flex flex-col gap-1" data-testid="parked-hand-off">
    <select aria-label="Hand off to" className="input" value={kind} disabled={disabled}
      onChange={event => setKind(event.target.value === 'session' ? 'session' : 'group')}>
      <option value="group">Group</option>
      <option value="session">Session</option>
    </select>
    <div className="flex gap-2">
      <input aria-label="Hand off target" className="input min-w-0 flex-1" value={target} disabled={disabled}
        placeholder={kind === 'group' ? 'group id' : 'session id'} list={kind === 'group' ? listId : undefined}
        onChange={event => setTarget(event.target.value)} />
      <datalist id={listId}>{groups.map(id => <option key={id} value={id} />)}</datalist>
      <button className="btn shrink-0" disabled={disabled || target.trim() === ''} onClick={send}>Hand off</button>
    </div>
    {result?.messageId === messageId && !result.ok && <p role="alert" className="text-chat-meta text-red-400">{result.error}</p>}
  </div>
}

// Store dispatches and notifications for the team mailbox/task message family
// and the Messages read model (team-message-threads 5.2): one paged list, its
// thread replies, and the human composer's send result. The view is
// host-agnostic and drives the wire itself; this is the host that feeds its
// store.
import { useTeamMailboxStore } from '../stores/teamMailboxStore'
import { useTeamMessageStore } from '../stores/teamMessageStore'
import { useTeamTaskStore } from '../stores/teamTaskStore'
import { notifyDeliveredToHuman, notifyMailboxDeadLetter } from '../utils/teamMailboxNotification'
import type { ServerMessage } from '@shared/types'
import type { MessageRouterDeps } from './types'

type TeamMessage = Extract<ServerMessage, { type: `team-${string}` }>

export function handleTeamMessage(message: TeamMessage, _deps: MessageRouterDeps): void {
  const mailbox = useTeamMailboxStore.getState()
  const messages = useTeamMessageStore.getState()
  switch (message.type) {
    case 'team-mailbox-snapshot': mailbox.apply(message); return
    case 'team-mailbox-rules-result': mailbox.applyRulesResult(message); return
    case 'team-mailbox-hand-off-result': mailbox.applyHandOffResult(message); return
    case 'team-mailbox-dead-letter': notifyMailboxDeadLetter(message); return
    case 'team-mailbox-delivered-to-human': notifyDeliveredToHuman(message); return
    case 'team-tasks-snapshot': useTeamTaskStore.getState().applySnapshot(message); return
    case 'team-task-detail': useTeamTaskStore.getState().applyDetail(message); return
    case 'team-task-result': useTeamTaskStore.getState().applyResult(message); return
    case 'team-messages-snapshot': messages.applySnapshot(message); return
    case 'team-messages': messages.applyPush(message); return
    case 'team-thread': messages.applyThread(message); return
    case 'team-message-send-result': messages.applyResult(message); return
  }
}

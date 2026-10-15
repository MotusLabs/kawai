// Store dispatches and notifications for the team mailbox/task message family
// and the Messages read model (team-message-threads 5.2): one paged list, its
// thread replies, and the human composer's send result. The view is
// host-agnostic and drives the wire itself; this is the host that feeds its
// store. A reply for a team key whose views moved (a rekey) is routed to
// the new key, so an in-flight result still settles its action.
import { useTeamMailboxStore } from '../stores/teamMailboxStore'
import { useTeamMessageStore } from '../stores/teamMessageStore'
import { useTeamTaskStore } from '../stores/teamTaskStore'
import { notifyDeliveredToHuman, notifyMailboxDeadLetter } from '../utils/teamMailboxNotification'
import { routedTeamPath } from '../utils/teamKeyAliases'
import type { ServerMessage } from '@shared/types'
import type { MessageRouterDeps } from './types'

type TeamMessage = Extract<ServerMessage, { type: `team-${string}` }>

const routed = <M extends { teamPath: string }>(message: M, views: Record<string, unknown>): M => {
  const teamPath = routedTeamPath(message.teamPath, views)
  return teamPath === message.teamPath ? message : { ...message, teamPath }
}

export function handleTeamMessage(message: TeamMessage, _deps: MessageRouterDeps): void {
  const mailbox = useTeamMailboxStore.getState()
  const messages = useTeamMessageStore.getState()
  const tasks = useTeamTaskStore.getState()
  switch (message.type) {
    case 'team-mailbox-snapshot': mailbox.apply(routed(message, mailbox.views)); return
    case 'team-mailbox-rules-result': mailbox.applyRulesResult(routed(message, mailbox.views)); return
    case 'team-mailbox-hand-off-result': mailbox.applyHandOffResult(routed(message, mailbox.views)); return
    case 'team-mailbox-dead-letter': notifyMailboxDeadLetter(message); return
    case 'team-mailbox-delivered-to-human': notifyDeliveredToHuman(message); return
    case 'team-tasks-snapshot': tasks.applySnapshot(routed(message, tasks.views)); return
    case 'team-task-detail': tasks.applyDetail(routed(message, tasks.views)); return
    case 'team-task-result': tasks.applyResult(routed(message, tasks.views)); return
    case 'team-task-preview-result': tasks.applyPreviewResult(routed(message, tasks.views)); return
    case 'team-task-targets-result': tasks.applyTargetsResult(routed(message, tasks.views)); return
    case 'team-messages-snapshot': messages.applySnapshot(routed(message, messages.views)); return
    case 'team-messages': messages.applyPush(routed(message, messages.views)); return
    case 'team-thread': messages.applyThread(routed(message, messages.views)); return
    case 'team-message-send-result': messages.applyResult(routed(message, messages.views)); return
  }
}

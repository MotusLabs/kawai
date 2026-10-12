// Store dispatches and notifications for the team mailbox/task message family.
import { useTeamMailboxStore } from '../stores/teamMailboxStore'
import { useTeamTaskStore } from '../stores/teamTaskStore'
import { notifyMailboxDeadLetter } from '../utils/teamMailboxNotification'
import type { ServerMessage } from '@shared/types'
import type { MessageRouterDeps } from './types'

type TeamMessage = Extract<ServerMessage, { type: `team-${string}` }>

export function handleTeamMessage(message: TeamMessage, _deps: MessageRouterDeps): void {
  const mailbox = useTeamMailboxStore.getState()
  switch (message.type) {
    case 'team-mailbox-snapshot': mailbox.apply(message); return
    case 'team-mailbox-rules-result': mailbox.applyRulesResult(message); return
    case 'team-mailbox-hand-off-result': mailbox.applyHandOffResult(message); return
    case 'team-mailbox-dead-letter': notifyMailboxDeadLetter(message); return
    case 'team-tasks-snapshot': useTeamTaskStore.getState().applySnapshot(message); return
    case 'team-task-detail': useTeamTaskStore.getState().applyDetail(message); return
    case 'team-task-result': useTeamTaskStore.getState().applyResult(message); return
  }
}

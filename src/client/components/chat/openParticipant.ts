// Opening a message participant's chat (team-message-threads D3): a live or an
// archived chat session both select as the current chat — the archived one
// then shows its read-only bar — and a killed participant never gets here,
// because `resolveParticipant` marks it gone and the label is not a button.
import { useSessionStore } from '../../stores/sessionStore'

export function openParticipantChat(sessionId: string): void {
  useSessionStore.getState().setSelectedSessionId(sessionId)
}

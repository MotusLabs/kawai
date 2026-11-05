// ChatSettings.tsx - the Chat tab of the Settings modal: the Claude provider
// environment settings, a pointer to the per-team default approval policy
// (unify-approval-defaults D1: set on the Team page, not here), the chat font
// size, and the server-persisted question auto-answer wait. The drafts live
// in the modal shell and commit on Save (design D5); the auto-answer wait
// saves itself.
import type { Ref } from 'react'
import ChatProviderSettings, { type ChatProviderSettingsHandle } from '../ChatProviderSettings'
import FontSizeStepper from '../FontSizeStepper'
import QuestionAutoAnswerSetting from './QuestionAutoAnswerSetting'
import {
  CHAT_FONT_SIZE_MIN,
  CHAT_FONT_SIZE_MAX,
} from '../../stores/settingsStore'

export interface ChatSettingsProps {
  providerSettingsRef: Ref<ChatProviderSettingsHandle>
  onProviderBusyChange: (busy: boolean) => void
  draftChatFontSize: number
  onDraftChatFontSizeChange: (size: number) => void
}

export default function ChatSettings({
  providerSettingsRef,
  onProviderBusyChange,
  draftChatFontSize,
  onDraftChatFontSizeChange,
}: ChatSettingsProps) {
  return (
    <>
      <ChatProviderSettings ref={providerSettingsRef} onBusyChange={onProviderBusyChange} />

      <div className="border-t border-border pt-4">
        <label className="mb-2 block text-xs text-secondary">
          New Chat Sessions
        </label>
        <div className="text-sm text-primary">Approval Policy</div>
        <div className="text-[10px] text-muted" data-testid="default-approval-policy-hint">
          The default approval policy is set per team on the Team page&apos;s Members tab. It seeds
          Auto-approve when you create a chat in that team, and applies to the team&apos;s spawned members.
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <label className="mb-2 block text-xs text-secondary">
          Chat Display
        </label>
        <FontSizeStepper
          label="Chat Font Size"
          hint="Chat text size in pixels (12-20)"
          value={draftChatFontSize}
          min={CHAT_FONT_SIZE_MIN}
          max={CHAT_FONT_SIZE_MAX}
          onChange={onDraftChatFontSizeChange}
        />
      </div>

      {/* The server-persisted question auto-answer wait saves itself with its
          own control (question-auto-answer D5); it is not a modal draft. */}
      <QuestionAutoAnswerSetting />
    </>
  )
}

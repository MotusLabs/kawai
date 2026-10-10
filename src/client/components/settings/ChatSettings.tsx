// ChatSettings.tsx - the Chat tab of the Settings modal: the default approval
// policy for new chat sessions (segmented, design D7), the Claude provider
// environment settings, and the chat font size. Both drafts live in the modal
// shell and commit on Save (design D5).
import type { ChatApprovalPolicy } from '@shared/types'
import ChatProviderSettings from '../ChatProviderSettings'
import FontSizeStepper from '../FontSizeStepper'
import {
  CHAT_FONT_SIZE_MIN,
  CHAT_FONT_SIZE_MAX,
} from '../../stores/settingsStore'

export interface ChatSettingsProps {
  draftDefaultApprovalPolicy: ChatApprovalPolicy
  onDraftDefaultApprovalPolicyChange: (policy: ChatApprovalPolicy) => void
  draftChatFontSize: number
  onDraftChatFontSizeChange: (size: number) => void
}

export default function ChatSettings({
  draftDefaultApprovalPolicy,
  onDraftDefaultApprovalPolicyChange,
  draftChatFontSize,
  onDraftChatFontSizeChange,
}: ChatSettingsProps) {
  return (
    <>
      <ChatProviderSettings />

      <div className="border-t border-border pt-4">
        <label className="mb-2 block text-xs text-secondary">
          New Chat Sessions
        </label>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Approval Policy</div>
            <div className="text-[10px] text-muted">
              Default for new chat sessions. Auto-approve lets tools run without asking.
            </div>
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              className={`btn text-xs px-3 ${draftDefaultApprovalPolicy === 'manual' ? 'btn-primary' : ''}`}
              onClick={() => onDraftDefaultApprovalPolicyChange('manual')}
            >
              Manual
            </button>
            <button
              type="button"
              className={`btn text-xs px-3 ${draftDefaultApprovalPolicy === 'auto' ? 'btn-primary' : ''}`}
              onClick={() => onDraftDefaultApprovalPolicyChange('auto')}
            >
              Auto-approve
            </button>
          </div>
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
    </>
  )
}

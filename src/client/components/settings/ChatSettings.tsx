// ChatSettings.tsx - the Chat tab of the Settings modal: a thin composition
// of the Claude provider environment settings and the chat font size. The
// font-size draft lives in the modal shell and commits on Save (design D5).
import ChatProviderSettings from '../ChatProviderSettings'
import FontSizeStepper from '../FontSizeStepper'
import {
  CHAT_FONT_SIZE_MIN,
  CHAT_FONT_SIZE_MAX,
} from '../../stores/settingsStore'

export interface ChatSettingsProps {
  draftChatFontSize: number
  onDraftChatFontSizeChange: (size: number) => void
}

export default function ChatSettings({
  draftChatFontSize,
  onDraftChatFontSizeChange,
}: ChatSettingsProps) {
  return (
    <>
      <ChatProviderSettings />

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

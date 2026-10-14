// The chat header's side-panel switcher (chat-header-layout D3): Tasks,
// Mailbox, Messages, and Strategy as one group of pressed-state buttons whose
// pressed entry is the panel open in the side slot. Not a tablist — "no panel
// open" is a valid state. Icon-only entries keep their panel name as the
// accessible name and tooltip. Debug is not here; it lives in the session menu.
import type { ComponentType, SVGProps } from 'react'
import CheckDone01Icon from '@untitledui-icons/react/line/esm/CheckDone01Icon'
import Inbox01Icon from '@untitledui-icons/react/line/esm/Inbox01Icon'
import MessageChatSquareIcon from '@untitledui-icons/react/line/esm/MessageChatSquareIcon'
import Target04Icon from '@untitledui-icons/react/line/esm/Target04Icon'
import type { SideSlot } from './sideSlot'

export type PanelSlot = Exclude<SideSlot, 'debug'>

export const PANEL_ENTRIES: ReadonlyArray<{ slot: PanelSlot; label: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }> = [
  { slot: 'tasks', label: 'Tasks', Icon: CheckDone01Icon },
  { slot: 'mailbox', label: 'Mailbox', Icon: Inbox01Icon },
  { slot: 'messages', label: 'Messages', Icon: MessageChatSquareIcon },
  { slot: 'strategy', label: 'Strategy', Icon: Target04Icon },
]

export default function ChatPanelSwitcher({ openSlot, onToggle, iconsOnly = false }: {
  openSlot: SideSlot | null
  onToggle: (slot: PanelSlot) => void
  iconsOnly?: boolean
}) {
  return (
    <div role="group" aria-label="Side panels" className="flex shrink-0 items-center gap-1" data-testid="chat-panel-switcher">
      {PANEL_ENTRIES.map(({ slot, label, Icon }) => {
        const pressed = openSlot === slot
        return (
          <button key={slot} type="button" aria-pressed={pressed} data-testid={`chat-panel-${slot}`}
            className={`btn text-chat-meta ${pressed ? 'btn-primary' : ''} ${iconsOnly ? 'px-2' : ''}`}
            onClick={() => onToggle(slot)} {...(iconsOnly ? { 'aria-label': label, title: label } : {})}>
            {iconsOnly ? <Icon aria-hidden="true" className="h-4 w-4" /> : label}
          </button>
        )
      })}
    </div>
  )
}

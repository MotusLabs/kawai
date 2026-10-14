// The chat header's session menu (chat-header-layout D4): Rename, Debug (a
// checkbox item, on while the debug panel is open), Archive for live chats,
// and Kill session last, styled as destructive. In the narrowest header
// layout the side-panel entries fold in first, with their selected state.
// The entries are a pure model (`sessionMenuEntries`) so their order and
// presence are testable without a DOM; Base UI's Menu supplies roving focus,
// typeahead, Escape, and focus return to the trigger. Rename skips that
// focus return so the name field keeps the focus it takes. The popup renders
// into the header so the chat palette and font size still apply.
import { useRef, type RefObject } from 'react'
import { Menu } from '@base-ui/react/menu'
import DotsHorizontalIcon from '@untitledui-icons/react/line/esm/DotsHorizontalIcon'
import { PANEL_ENTRIES } from './ChatPanelSwitcher'
import type { SideSlot } from './sideSlot'

export type SessionMenuEntry =
  | { kind: 'item'; id: string; label: string; onSelect: () => void; danger?: boolean; keepFocus?: boolean }
  | { kind: 'check'; id: string; label: string; checked: boolean; onToggle: () => void }
  | { kind: 'separator'; id: string }

export function sessionMenuEntries({ archived, openSlot, foldPanels, onRename, onToggleSlot, onArchive, onKill }: {
  archived: boolean
  openSlot: SideSlot | null
  foldPanels: boolean
  onRename: () => void
  onToggleSlot: (slot: SideSlot) => void
  onArchive: () => void
  onKill: () => void
}): SessionMenuEntry[] {
  const panels: SessionMenuEntry[] = foldPanels
    ? [
        ...PANEL_ENTRIES.map(({ slot, label }): SessionMenuEntry => ({
          kind: 'check', id: `panel-${slot}`, label, checked: openSlot === slot, onToggle: () => onToggleSlot(slot),
        })),
        { kind: 'separator', id: 'after-panels' },
      ]
    : []
  return [
    ...panels,
    { kind: 'item', id: 'rename', label: 'Rename', onSelect: onRename, keepFocus: true },
    { kind: 'check', id: 'debug', label: 'Debug', checked: openSlot === 'debug', onToggle: () => onToggleSlot('debug') },
    { kind: 'separator', id: 'before-lifecycle' },
    ...(archived ? [] : [{ kind: 'item', id: 'archive', label: 'Archive', onSelect: onArchive } as const]),
    { kind: 'item', id: 'kill', label: 'Kill session', onSelect: onKill, danger: true },
  ]
}

const TEST_IDS: Record<string, string> = { archive: 'chat-archive-button', kill: 'chat-kill-button', debug: 'chat-debug-toggle' }
const ROW = 'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-chat-meta outline-none data-[highlighted]:bg-hover'

export default function ChatSessionMenu({ entries, container }: {
  entries: SessionMenuEntry[]
  container: RefObject<HTMLElement | null>
}) {
  const keepFocus = useRef(false)
  return (
    <Menu.Root onOpenChange={open => { if (open) keepFocus.current = false }}>
      <Menu.Trigger className="btn px-2 text-chat-meta" aria-label="Session actions" title="Session actions" data-testid="chat-session-menu">
        <DotsHorizontalIcon aria-hidden="true" className="h-4 w-4" />
      </Menu.Trigger>
      <Menu.Portal container={container}>
        <Menu.Positioner sideOffset={4} align="end" className="z-50">
          <Menu.Popup finalFocus={() => !keepFocus.current}
            className="min-w-[180px] rounded-md border border-border bg-elevated py-1 text-secondary shadow-lg outline-none">
            {entries.map(entry => {
              if (entry.kind === 'separator') return <Menu.Separator key={entry.id} className="my-1 h-px bg-border" />
              if (entry.kind === 'check') {
                return (
                  <Menu.CheckboxItem key={entry.id} checked={entry.checked} onCheckedChange={entry.onToggle} closeOnClick
                    className={`${ROW} hover:text-primary`} data-testid={TEST_IDS[entry.id] ?? `chat-menu-${entry.id}`}>
                    <span aria-hidden="true" className="w-3 text-center">{entry.checked ? '✓' : ''}</span>
                    {entry.label}
                  </Menu.CheckboxItem>
                )
              }
              return (
                <Menu.Item key={entry.id} data-testid={TEST_IDS[entry.id] ?? `chat-menu-${entry.id}`}
                  className={`${ROW} ${entry.danger ? 'text-danger' : 'hover:text-primary'}`}
                  onClick={() => { keepFocus.current = entry.keepFocus ?? false; entry.onSelect() }}>
                  <span aria-hidden="true" className="w-3" />
                  {entry.label}
                </Menu.Item>
              )
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

// Navigator chat search box (chat-session-search D6): the combobox that owns
// the query and drives the results list from the keyboard. Focus never leaves
// it — ↑/↓ move the active result, Enter opens it, Escape clears — and the
// modifier+K shortcut focuses it through the store's focus token.
import { useEffect, useRef, useState } from 'react'
import XCloseIcon from '@untitledui-icons/react/line/esm/XCloseIcon'
import {
  SEARCH_LISTBOX_ID,
  flattenSearchItems,
  useSessionSearchStore,
} from '../stores/sessionSearchStore'
import { openSearchItem } from '../utils/openSearchItem'
import { normalizeSearchQuery } from '@shared/sessionSearch'

interface SessionSearchBoxProps {
  /** Display string of the shortcut modifier, e.g. `⌃⇧`. */
  modDisplay: string
}

export default function SessionSearchBox({ modDisplay }: SessionSearchBoxProps) {
  const query = useSessionSearchStore(state => state.query)
  const response = useSessionSearchStore(state => state.response)
  const activeIndex = useSessionSearchStore(state => state.activeIndex)
  const focusToken = useSessionSearchStore(state => state.focusToken)
  const inputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const expanded = normalizeSearchQuery(query) !== null
  const activeId = flattenSearchItems(response)[activeIndex]?.id

  // Only a request made while mounted focuses the box: a token bumped before
  // this mount (an earlier shortcut press) must not steal focus on remount.
  const seenToken = useRef(focusToken)
  useEffect(() => {
    if (focusToken === seenToken.current) return
    seenToken.current = focusToken
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusToken])

  const onKeyDown = (event: { key: string; preventDefault: () => void }) => {
    const store = useSessionSearchStore.getState()
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      store.moveActive(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter') {
      const item = flattenSearchItems(store.response)[store.activeIndex]
      if (!item) return
      event.preventDefault()
      openSearchItem(item)
    } else if (event.key === 'Escape' && store.query !== '') {
      event.preventDefault()
      store.clear()
    }
  }

  return (
    <div className="relative flex min-w-32 flex-1 items-center">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label="Search chats"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={SEARCH_LISTBOX_ID}
        aria-activedescendant={activeId}
        placeholder="Search chats"
        value={query}
        spellCheck={false}
        autoComplete="off"
        onChange={event => useSessionSearchStore.getState().setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="h-6 w-full rounded border border-border bg-base pl-2 pr-12 text-[11px] text-primary placeholder:text-muted focus:border-accent focus:outline-none"
      />
      {query !== '' ? (
        <button
          type="button"
          aria-label="Clear search"
          title="Clear search"
          onClick={() => {
            useSessionSearchStore.getState().clear()
            inputRef.current?.focus()
          }}
          className="absolute right-1 flex h-4 w-4 items-center justify-center rounded text-muted hover:bg-hover hover:text-primary"
        >
          <XCloseIcon width={12} height={12} />
        </button>
      ) : !focused ? (
        <kbd className="pointer-events-none absolute right-1.5 text-[10px] text-muted">{modDisplay}K</kbd>
      ) : null}
    </div>
  )
}

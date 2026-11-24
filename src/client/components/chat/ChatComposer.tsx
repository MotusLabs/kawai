// Composer state stays below ChatView so editing never renders history.
// Remounted by session id to reset caret/menu state while stored drafts survive.
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatCommandState } from '@shared/chat'
import type { SessionStatus } from '@shared/types'
import { useChatStore } from '../../stores/chatStore'
import SlashCommandMenu from './SlashCommandMenu'
import { filterChatCommands, insertCommand, slashTokenAt } from './slashCommandFilter'
import { EMPTY_DRAFT_IMAGES, pastedImages, useChatImageDrafts } from '../../stores/chatImageDrafts'
import ChatDraftImages from './ChatDraftImages'

export default function ChatComposer({ sessionId, status, connected, commandState, onSubmit, onInterrupt, attachment }: {
  sessionId: string; status: SessionStatus; connected: boolean; commandState: ChatCommandState
  onSubmit: (text: string) => void | boolean; onInterrupt: () => void
  /** The captured-plan-attachment line (§6.3); absent in ordinary hosts. */
  attachment?: ReactNode
}) {
  const text = useChatStore(state => state.drafts[sessionId] ?? '')
  const images = useChatImageDrafts(state => state.drafts[sessionId] ?? EMPTY_DRAFT_IMAGES)
  const revision = useChatImageDrafts(state => state.revisions[sessionId] ?? 0)
  const attempts = useChatImageDrafts(state => state.attempts)
  const sending = Object.values(attempts).some(p => p.sessionId === sessionId && p.revision === revision && ['uploading', 'awaiting-result'].includes(p.state))
  const setDraft = useChatStore(state => state.setDraft)
  const setText = (value: string) => setDraft(sessionId, value)
  // Slash-command menu: open while the caret is inside a `/` word anywhere in
  // the message (slash-command-autocomplete-anywhere design D2) and a list can
  // exist. Escape dismisses until the token changes; Enter/Tab choose only with
  // a highlighted match, so unknown commands still send as typed.
  const [highlighted, setHighlighted] = useState(0)
  const [menuDismissed, setMenuDismissed] = useState(false)
  const [caret, setCaret] = useState<number | null>(null)
  const token = useMemo(() => (caret == null ? null : slashTokenAt(text, caret)), [text, caret])
  // A new token starts on its first match and undismissed in the same render
  // that first sees it (React's adjust-state-while-rendering pattern), so the
  // next key never acts on the previous token's highlight or Escape. A
  // passive-effect reset is a deferred update that a quick key can beat.
  const tokenKey = token ? `${token.start}:${token.query}` : null
  const [seenTokenKey, setSeenTokenKey] = useState(tokenKey)
  if (seenTokenKey !== tokenKey) {
    setSeenTokenKey(tokenKey)
    setHighlighted(0)
    setMenuDismissed(false)
  }
  const menuOpen =
    token !== null && !menuDismissed && commandState.status !== 'unavailable'
  const matches = useMemo(
    () => (menuOpen && token ? filterChatCommands(commandState.commands, token.query) : []),
    [menuOpen, commandState.commands, token]
  )
  // Choosing replaces only the token's word, in place (design D3): the caret
  // state lands just after the inserted `/name `, and the layout effect below
  // restores the DOM caret there after the choice commits. The restore is
  // keyed on a fresh object per choice, not on the text: choosing a command
  // that is already spelled out in the word leaves the value unchanged, so a
  // text-keyed effect would never fire — the DOM caret would stay mid-word and
  // the stale restore would land on the next keystroke instead.
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const [caretRestore, setCaretRestore] = useState<{ caret: number } | null>(null)
  useLayoutEffect(() => {
    if (caretRestore) composerRef.current?.setSelectionRange(caretRestore.caret, caretRestore.caret)
  }, [caretRestore])
  const chooseCommand = (name: string) => {
    if (!token) return
    const next = insertCommand(text, token, name)
    setText(next.text)
    setCaret(next.caret)
    setCaretRestore({ caret: next.caret })
  }
  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlighted((highlighted + 1) % matches.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlighted((highlighted - 1 + matches.length) % matches.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const chosen = matches[highlighted] ?? matches[0]!
        chooseCommand(chosen.name)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenuDismissed(true)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }
  // The caret drives the slash menu (design D2). A non-collapsed selection has
  // no single caret and keeps the menu closed; when the event carries no
  // selectionStart (the test renderer), typing left the caret at the end.
  const handleComposerChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const { value, selectionStart, selectionEnd } = event.target
    setText(value)
    if (selectionStart == null) setCaret(value.length)
    else setCaret(selectionStart === selectionEnd ? selectionStart : null)
  }
  // onSelect covers caret moves that never type: arrows, clicks, selections.
  const handleComposerSelect = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const { selectionStart, selectionEnd } = event.target as HTMLTextAreaElement
    if (selectionStart == null) return
    setCaret(selectionStart === selectionEnd ? selectionStart : null)
  }
  // The argument hint of a just-inserted or typed `/<name> ` directly before
  // the caret (design D4) shows until the user types arguments (the
  // trailing-space match stops matching then).
  const hintName = caret == null ? null : /(?:^|\s)\/(\S+) $/.exec(text.slice(0, caret))?.[1]
  const hintCommand = hintName
    ? commandState.commands.find(
        (command) => command.name === hintName || command.aliases.includes(hintName)
      )
    : undefined
  return <form className="border-t border-border p-3" onSubmit={event => {
    event.preventDefault()
    if (!connected || sending || (!text.trim() && !images.length)) return
    if (onSubmit(text.trim()) !== false) setText('')
  }}>
    <div className="mx-auto max-w-4xl">
      {menuOpen && (
        <div className="mb-2">
          <SlashCommandMenu matches={matches} loading={commandState.status === 'loading'}
            highlightedIndex={highlighted} onHighlight={setHighlighted}
            onChoose={command => chooseCommand(command.name)} />
        </div>
      )}
      {attachment}
      <ChatDraftImages sessionId={sessionId} />
      <div className="flex items-end gap-2">
        <textarea ref={composerRef} aria-label="Message Claude" className="input chat-composer min-h-20 flex-1 resize-y text-chat-body" value={text}
          disabled={!connected} placeholder="Message Claude…" onChange={handleComposerChange}
          onSelect={handleComposerSelect} onKeyDown={handleComposerKeyDown}
          onPaste={event => {
            const pasted = pastedImages(event.clipboardData)
            if (!pasted.hasImages) return
            event.preventDefault()
            if (!pasted.files.length) useChatImageDrafts.getState().error(sessionId, 'The browser did not provide image data. Copy the image itself and try again.')
            else useChatImageDrafts.getState().add(sessionId, pasted.files)
          }} />
        <button className="btn btn-primary text-chat-meta" disabled={!connected || sending || (!text.trim() && !images.length)}>Send</button>
        <button type="button" className="btn text-chat-meta" disabled={!connected || status === 'waiting'}
          onClick={onInterrupt}>Stop</button>
      </div>
      {hintCommand?.argumentHint && (
        <p className="mt-1 font-mono text-xs text-muted" data-testid="command-argument-hint">
          /{hintCommand.name} {hintCommand.argumentHint}
        </p>
      )}
    </div>
  </form>
}

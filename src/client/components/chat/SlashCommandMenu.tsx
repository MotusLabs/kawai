// The composer's slash-command menu (add-chat-slash-commands design D5):
// purely presentational. ChatView owns the text, the filtering, the keyboard
// state, and Enter/Tab/Escape — this component renders the list, the loading
// and empty states, and reports pointer selection.
import type { ChatCommand } from '@shared/chat'

export default function SlashCommandMenu({ matches, loading, highlightedIndex, onHighlight, onChoose }: {
  /** Pre-filtered, pre-ranked by slashCommandFilter. */
  matches: ChatCommand[]
  /** True while the agent has not reported its commands yet. */
  loading?: boolean
  highlightedIndex: number
  onHighlight: (index: number) => void
  onChoose: (command: ChatCommand) => void
}) {
  return <div role="listbox" aria-label="Slash commands" data-testid="slash-command-menu"
    className="max-h-64 overflow-y-auto rounded-md border border-border bg-elevated p-1 text-sm shadow-lg">
    {loading ? (
      <p className="px-2 py-1.5 text-xs text-secondary" data-testid="slash-command-loading">Loading commands…</p>
    ) : matches.length === 0 ? (
      <p className="px-2 py-1.5 text-xs text-secondary" data-testid="slash-command-empty">No matching commands</p>
    ) : (
      matches.map((command, index) => (
        <button type="button" role="option" key={command.name}
          aria-selected={index === highlightedIndex}
          data-command-name={command.name}
          className={`flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left ${
            index === highlightedIndex ? 'bg-hover text-accent' : 'hover:bg-hover'
          }`}
          // Pointer movement highlights without scrolling the list (hover);
          // a click chooses immediately.
          onPointerEnter={() => onHighlight(index)}
          onClick={() => onChoose(command)}>
          <span className="font-mono text-xs whitespace-nowrap">/{command.name}</span>
          {command.argumentHint && <span className="font-mono text-xs text-muted whitespace-nowrap">{command.argumentHint}</span>}
          <span className="min-w-0 flex-1 truncate text-xs text-secondary">{command.description}</span>
          {command.source === 'project' && <span className="rounded border border-border px-1 text-xs text-secondary" data-testid="command-source-tag">project</span>}
          {command.source === 'user' && <span className="rounded border border-border px-1 text-xs text-secondary" data-testid="command-source-tag">user</span>}
        </button>
      ))
    )}
  </div>
}

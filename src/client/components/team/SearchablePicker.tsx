// Filter-as-you-type picker for the task form's worktree and OpenSpec-change
// fields (task-assignment 5.1). Choosing from the list sets the exact value
// the server listed; typing is the advanced manual-entry mode and submits
// through the same server validation (there is no second path). The list is
// re-requested whenever the picker opens or regains focus, so a worktree
// created through the linked flow shows up on return, and a `refresh` is
// cheap. Keyboard: arrows move the highlight, Enter picks it (or accepts the
// typed value), Escape closes.
import { useEffect, useMemo, useRef, useState } from 'react'

export interface PickerOption {
  /** The value submitted when this option is chosen. */
  value: string
  /** Main text shown in the list. */
  label: string
  /** Supporting detail (branch, location, …). */
  hint?: string
}

export default function SearchablePicker({ value, onChange, options, placeholder, ariaLabel, disabled, loading, refresh, onCreateWorktree, createLabel, testId }: {
  value: string
  onChange: (value: string) => void
  options: PickerOption[]
  placeholder: string
  ariaLabel: string
  disabled?: boolean
  loading?: boolean
  /** Re-request the option list (called on open and on focus). */
  refresh?: () => void
  /** Opens the existing worktree-creation flow; hidden when absent. */
  onCreateWorktree?: () => void
  createLabel?: string
  testId: string
}) {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const matches = useMemo(() => {
    const needle = value.trim().toLowerCase()
    return options.filter(option =>
      !needle || option.value.toLowerCase().includes(needle) ||
      option.label.toLowerCase().includes(needle) || option.hint?.toLowerCase().includes(needle))
  }, [options, value])
  useEffect(() => { setHighlight(0) }, [value, open])
  const choose = (option: PickerOption) => {
    onChange(option.value)
    setOpen(false)
    inputRef.current?.blur()
  }
  return <div className="relative" data-testid={testId}>
    <input
      ref={inputRef}
      className="input w-full text-chat-body"
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      disabled={disabled}
      data-testid={`${testId}-input`}
      onFocus={() => { setOpen(true); refresh?.() }}
      onBlur={() => { setOpen(false) }}
      onChange={event => { onChange(event.target.value); setOpen(true) }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setOpen(true)
          setHighlight(index => Math.min(index + 1, Math.max(matches.length - 1, 0)))
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          setHighlight(index => Math.max(index - 1, 0))
        } else if (event.key === 'Enter' && open) {
          event.preventDefault()
          if (matches[highlight]) choose(matches[highlight])
        } else if (event.key === 'Escape') {
          setOpen(false)
        }
      }}
    />
    {open && !disabled && <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded border border-border bg-surface shadow-lg"
      role="listbox" aria-label={`${ariaLabel} options`} data-testid={`${testId}-options`}>
      {loading && <p className="p-2 text-chat-meta text-secondary">Loading…</p>}
      {!loading && matches.length === 0 && <p className="p-2 text-chat-meta text-secondary">
        No matches — typed entries are validated by the server on submit.</p>}
      {matches.map((option, index) => <button
        key={option.value} type="button" role="option" aria-selected={index === highlight}
        className={`block w-full px-2 py-1 text-left text-chat-body ${index === highlight ? 'bg-accent text-white' : 'hover:bg-border'}`}
        // mousedown, not click: the input's blur would close the list first.
        onMouseDown={event => { event.preventDefault(); choose(option) }}
        onMouseEnter={() => setHighlight(index)}
        data-testid={`${testId}-option`} data-value={option.value}>
        <span className="block truncate">{option.label}</span>
        {option.hint && <span className={`block truncate text-chat-meta ${index === highlight ? 'text-white/80' : 'text-secondary'}`}>{option.hint}</span>}
      </button>)}
      {onCreateWorktree && <button type="button"
        className="block w-full border-t border-border px-2 py-1 text-left text-chat-meta text-secondary hover:bg-border"
        onMouseDown={event => { event.preventDefault(); setOpen(false); onCreateWorktree() }}
        data-testid={`${testId}-create`}>
        {createLabel ?? 'Create a worktree…'}
      </button>}
    </div>}
  </div>
}

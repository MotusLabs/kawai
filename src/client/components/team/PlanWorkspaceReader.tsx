// The plan workspace's document reader (plan-workspace 5.3, design D4): the
// plan's supporting references with their add/remove controls, and one open
// document at a time with its provenance — source worktree and path, current
// versus last-valid content, and the selected execution's artifact-pin match
// when the pin contract knows one. Relative links and images navigate within
// the reader through the scoped resolvers; the server enforces every
// boundary. External https references open separately and are never fetched.
import { useState } from 'react'
import type { WorkspaceRefView } from '@shared/planWorkspace'
import type { PlanWorkspaceView, WorkspaceDocumentSelection } from '../../stores/teamPlanWorkspaceStore'
import { documentKey } from '../../stores/teamPlanWorkspaceStore'
import {
  readerAssetUrl, resolveReaderImage, resolveReaderLink, type ReaderDocument,
} from '../../utils/planWorkspaceMarkdown'
import { shortHash } from '../chat/strategyLabels'
import Markdown from '../Markdown'

export interface ReaderWorktree {
  /** The worktree root path (the server matches it lexically against its listed roots). */
  path: string
  label: string
}

/** What a ref-add sends; the server validates plan/change/worktree scope (design D4). */
export interface ReaderRefAdd {
  label: string
  kind: 'local' | 'external'
  changeName?: string
  worktreeId?: string
  relativePath?: string
  url?: string
}

export default function PlanWorkspaceReader({ teamPath, refs, selectedChange, executionId, view, worktrees, connected, onOpenDocument, onAddRef, onRemoveRef }: {
  /** The team key the scoped asset route addresses. */
  teamPath: string
  refs: WorkspaceRefView[]
  selectedChange: string | null
  /** The displayed execution id (null = latest); names the pin the provenance compares. */
  executionId: string | null
  view: PlanWorkspaceView
  worktrees: ReaderWorktree[]
  connected: boolean
  onOpenDocument: (selection: WorkspaceDocumentSelection | null) => void
  onAddRef: (payload: ReaderRefAdd) => void
  onRemoveRef: (refId: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const visibleRefs = refs.filter(ref => ref.changeName === null || ref.changeName === selectedChange)
  return <section data-testid="plan-workspace-reader" aria-label="Documents" className="mt-3">
    <h4 className="font-medium">Documents</h4>
    <RefList refs={visibleRefs} view={view}
      connected={connected} onOpenDocument={onOpenDocument} onRemoveRef={onRemoveRef} />
    {adding
      ? <AddRefForm worktrees={worktrees} selectedChange={selectedChange} connected={connected}
        onAdd={payload => { onAddRef(payload); setAdding(false) }} onCancel={() => setAdding(false)} />
      : <button type="button" className="btn mt-2 text-xs" data-testid="reader-add-ref" disabled={!connected}
        onClick={() => setAdding(true)}>Add reference</button>}
    <DocumentArea selection={view.selectedDocument} view={view} executionId={executionId} teamPath={teamPath}
      connected={connected} onOpenDocument={onOpenDocument} />
  </section>
}

function RefList({ refs, view, connected, onOpenDocument, onRemoveRef }: {
  refs: WorkspaceRefView[]
  view: PlanWorkspaceView
  connected: boolean
  onOpenDocument: (selection: WorkspaceDocumentSelection | null) => void
  onRemoveRef: (refId: string) => void
}) {
  if (refs.length === 0) {
    return <p className="mt-1 text-chat-meta text-secondary" data-testid="reader-refs-empty">No references.</p>
  }
  return <ul className="mt-1 space-y-1" data-testid="reader-refs">
    {/* `reference`, never `ref` — the reserved prop would arrive undefined. */}
    {refs.map(reference => <RefRow key={reference.id} reference={reference}
      view={view} connected={connected} onOpenDocument={onOpenDocument} onRemoveRef={onRemoveRef} />)}
  </ul>
}

function RefRow({ reference, view, connected, onOpenDocument, onRemoveRef }: {
  reference: WorkspaceRefView
  view: PlanWorkspaceView
  connected: boolean
  onOpenDocument: (selection: WorkspaceDocumentSelection | null) => void
  onRemoveRef: (refId: string) => void
}) {
  const isDisplayed = view.selectedDocument !== null
    && reference.kind === 'local'
    && view.selectedDocument.worktreeId === reference.worktreeId
    && view.selectedDocument.relativePath === reference.relativePath
  const document = reference.kind === 'local' && reference.worktreeId !== null && reference.relativePath !== null
    ? view.documents[documentKey({ worktreeId: reference.worktreeId, relativePath: reference.relativePath })] ?? null
    : null
  const broken = reference.kind === 'local' && document !== null && document.availability === 'missing' && !document.stale
  return <li className="flex flex-wrap items-baseline gap-x-2 border border-border p-1.5" data-testid={`reader-ref-${reference.id}`}>
    <span className="font-medium">{reference.label}</span>
    <span className="text-chat-meta text-secondary">
      {reference.kind === 'external'
        ? <a href={reference.url ?? '#'} target="_blank" rel="noreferrer noopener" className="underline">{reference.url}</a>
        : `${reference.worktreeId?.split('/').filter(Boolean).at(-1) ?? '?'} · ${reference.relativePath}`}
      {reference.changeName !== null && ` · change ${reference.changeName}`}
    </span>
    {reference.kind === 'local' && reference.worktreeId !== null && reference.relativePath !== null && (
      <button type="button" className="btn px-1.5 py-0.5 text-xs" data-testid={`reader-open-${reference.id}`}
        aria-pressed={isDisplayed || undefined} disabled={!connected}
        onClick={() => onOpenDocument(isDisplayed
          ? null
          : { worktreeId: reference.worktreeId!, relativePath: reference.relativePath! })}>
        {isDisplayed ? 'Close' : 'Open'}
      </button>
    )}
    {broken && <span className="text-chat-meta text-approval" data-testid={`reader-broken-${reference.id}`}>broken: {document!.reason ?? 'missing'}</span>}
    <button type="button" className="btn px-1.5 py-0.5 text-xs text-chat-danger" data-testid={`reader-remove-${reference.id}`}
      disabled={!connected} onClick={() => onRemoveRef(reference.id)}>Remove</button>
  </li>
}

function AddRefForm({ worktrees, selectedChange, connected, onAdd, onCancel }: {
  worktrees: ReaderWorktree[]
  selectedChange: string | null
  connected: boolean
  onAdd: (payload: ReaderRefAdd) => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<'local' | 'external'>('local')
  const [worktreeId, setWorktreeId] = useState(worktrees[0]?.path ?? '')
  const [relativePath, setRelativePath] = useState('')
  const [url, setUrl] = useState('')
  const submit = () => {
    if (label.trim() === '') return
    if (kind === 'local' && (worktreeId === '' || relativePath.trim() === '')) return
    if (kind === 'external' && url.trim() === '') return
    onAdd({
      label: label.trim(),
      kind,
      ...(selectedChange !== null ? { changeName: selectedChange } : {}),
      ...(kind === 'local' ? { worktreeId, relativePath: relativePath.trim() } : { url: url.trim() }),
    })
  }
  return <div className="mt-2 border border-border p-2" data-testid="reader-add-form">
    <div className="flex flex-wrap gap-2">
      <input aria-label="Reference label" className="input" value={label} onChange={event => setLabel(event.target.value)} />
      <select aria-label="Reference kind" className="input" value={kind} onChange={event => setKind(event.target.value as 'local' | 'external')}>
        <option value="local">Repository file</option>
        <option value="external">External link</option>
      </select>
      {kind === 'local' && <>
        <select aria-label="Reference worktree" className="input" value={worktreeId} onChange={event => setWorktreeId(event.target.value)}>
          {worktrees.length === 0 && <option value="">No worktrees discovered</option>}
          {worktrees.map(worktree => <option key={worktree.path} value={worktree.path}>{worktree.label}</option>)}
        </select>
        <input aria-label="Relative path" className="input" placeholder="docs/architecture.md" value={relativePath}
          onChange={event => setRelativePath(event.target.value)} />
      </>}
      {kind === 'external' && <input aria-label="External URL" className="input" placeholder="https://example.internal/spec" value={url}
        onChange={event => setUrl(event.target.value)} />}
    </div>
    <p className="mt-1 text-chat-meta text-secondary">
      Scope: {selectedChange !== null ? `change ${selectedChange}` : 'whole plan'}.
    </p>
    <div className="mt-1 flex gap-1">
      <button type="button" className="btn btn-primary text-xs" data-testid="reader-add-confirm" disabled={!connected} onClick={submit}>Add</button>
      <button type="button" className="btn text-xs" onClick={onCancel}>Cancel</button>
    </div>
  </div>
}

/** The displayed document's provenance line and body (design D4). */
function DocumentArea({ selection, view, executionId, teamPath, connected, onOpenDocument }: {
  selection: WorkspaceDocumentSelection | null
  view: PlanWorkspaceView
  executionId: string | null
  teamPath: string
  connected: boolean
  onOpenDocument: (selection: WorkspaceDocumentSelection | null) => void
}) {
  if (selection === null) {
    return <p className="mt-2 text-chat-meta text-secondary" data-testid="reader-document-none">No document open.</p>
  }
  const document = view.documents[documentKey(selection)] ?? null
  if (document === null) {
    return <p role="status" className="mt-2 text-chat-meta text-secondary" data-testid="reader-document-loading">Loading document…</p>
  }
  const close = <button type="button" className="btn px-1.5 py-0.5 text-xs" data-testid="reader-document-close"
    onClick={() => onOpenDocument(null)}>Close</button>
  const reader: ReaderDocument = { worktreeId: selection.worktreeId, relativePath: selection.relativePath, teamPath }
  return <div className="mt-2 border border-border p-2" data-testid="reader-document">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <p className="text-chat-meta text-secondary" data-testid="reader-document-provenance">
        {document.worktreeId.split('/').filter(Boolean).at(-1)} · {document.relativePath}
        {document.contentHash !== null && ` · ${shortHash(document.contentHash)}`}
        {document.size !== null && ` · ${document.size} bytes`}
      </p>
      {close}
    </div>
    <ProvenanceBadges document={document} executionId={executionId} />
    {document.kind === 'markdown' && document.text !== null && (
      <div className="mt-2" data-testid="reader-document-body">
        <Markdown
          content={document.text}
          resolvers={{
            resolveLink: href => resolveReaderLink(reader, href),
            resolveImage: src => resolveReaderImage(reader, src),
            onOpenDocument: relativePath => { if (connected) onOpenDocument({ worktreeId: selection.worktreeId, relativePath }) },
          }}
        />
      </div>
    )}
    {document.kind === 'image' && (
      <img src={readerAssetUrl(reader, selection.relativePath)} alt={selection.relativePath}
        className="mt-2 max-w-full" data-testid="reader-document-image" />
    )}
    {document.kind === null && (
      <p className="mt-2 text-chat-meta text-approval" data-testid="reader-document-unsupported">
        {document.reason ?? 'This file type is not rendered here.'} Path: {selection.relativePath}
      </p>
    )}
  </div>
}

function ProvenanceBadges({ document, executionId }: {
  document: PlanWorkspaceView['documents'][string]
  executionId: string | null
}) {
  return <p className="text-chat-meta" data-testid="reader-document-state">
    {document.availability === 'missing'
      ? <span className="text-approval">{document.stale
        ? `Source missing — showing the last valid content (${document.reason ?? 'unreadable'})`
        : `Missing: ${document.reason ?? 'the file could not be read'}`}</span>
      : <span>Current file</span>}
    {executionId !== null && <span> · execution {shortHash(executionId)}: {matchLabel(document.executionMatch)}</span>}
  </p>
}

function matchLabel(match: 'match' | 'mismatch' | 'unknown'): string {
  if (match === 'match') return 'matches the execution’s recorded artifact'
  if (match === 'mismatch') return 'current content differs from that execution’s input'
  return 'Execution match unknown'
}


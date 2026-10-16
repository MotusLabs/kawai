// Transcript row primitives (chat-transcript-layout D1). A message row is an
// article with an author/time metadata slot and a body slot: the transcript
// container (`.chat-transcript`, a CSS inline-size container) puts metadata in
// an em-sized gutter beside the body when it is wide enough and stacks it
// above the body when narrow — by its own width and chat font, not the
// viewport, so Debug, the navigator, and nested worker transcripts reflow it.
// Aside rows (tools, notices, errors) have no metadata and align with the
// body column. `.chat-row` styles live in index.css. Gutter and separator text
// use text-secondary, whose 4.5:1 floor chatPalette.test.ts asserts.
import type { ReactNode } from 'react'
import ChatTime from './ChatTime'

/** Spacing for a row: wide at a turn, a quiet divider at an author change. */
export function rowSpacing(first: boolean, turnStart: boolean, authorStart: boolean): string {
  if (first) return ''
  if (turnStart) return 'chat-row-turn'
  if (authorStart) return 'chat-row-author'
  return 'chat-row-continue'
}

export function MessageRow({ author, showAuthor, at, spacing, role, anchorId, bodyClassName = '', children }: {
  author: ReactNode
  /** False for a same-author continuation: the author stays for assistive technology only. */
  showAuthor: boolean
  at: string
  spacing: string
  role: 'user' | 'assistant' | 'peer'
  anchorId: string
  bodyClassName?: string
  children: ReactNode
}) {
  return <article data-anchor-id={anchorId} data-chat-role={role} className={`chat-row ${spacing}`.trim()}>
    <div className="chat-row-meta text-chat-meta text-secondary" data-testid="chat-row-meta">
      <span className={showAuthor ? 'font-semibold' : 'sr-only'} data-testid="chat-row-author">{author}</span>
      <ChatTime at={at} />
    </div>
    <div className={`chat-row-body min-w-0 ${bodyClassName}`.trim()}>{children}</div>
  </article>
}

export function AsideRow({ spacing, children }: { spacing: string; children: ReactNode }) {
  return <div className={`chat-row chat-row-aside ${spacing}`.trim()}>
    <div className="chat-row-body min-w-0">{children}</div>
  </div>
}

export function DaySeparator({ label }: { label: string }) {
  return <div className="chat-day text-chat-meta text-secondary" data-testid="chat-day-separator">
    <span>{label}</span>
  </div>
}

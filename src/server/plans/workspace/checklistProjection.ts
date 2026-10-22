// Markdown task-list projection for the plan workspace (2.2, design D3).
// Parses a tasks artifact with remark (GFM) and projects enclosing headings
// and GFM task-list items in source order. The projection is read-only —
// never Kawai tasks — and task *numbers* in item text are never parsed into
// identity: a row's key is local to the source content hash and its 1-based
// source line, so a duplicate numbering stays distinct and a replaced
// document changes every key with its hash.
//
// Fenced and indented code blocks are `code` nodes whose content the parser
// never tokenizes, so `- [x]` examples inside them are inert; so is
// Markdown in HTML blocks. Items before the first heading are not projected
// (OpenSpec tasks artifacts open with a heading). Sub-list items project as
// their own items in source order, carrying the additive nesting `depth`
// (1 = a top-level list item).
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { ListItem, PhrasingContent, RootContent } from 'mdast'
import type {
  WorkspaceChecklist, WorkspaceChecklistItem, WorkspaceChecklistSection,
} from '../../../shared/planWorkspace'

const parser = unified().use(remarkParse).use(remarkGfm)

/** Flattens phrasing content to its text (inline code kept, formatting dropped). */
function flattenPhrasing(nodes: readonly PhrasingContent[]): string {
  return nodes.map(node => 'value' in node && typeof node.value === 'string'
    ? node.value
    : 'children' in node ? flattenPhrasing(node.children as readonly PhrasingContent[]) : ''
  ).join('')
}

/** The item's own text: its phrasing content only — nested lists project separately. */
function itemText(item: ListItem): string {
  const parts: string[] = []
  for (const child of item.children) {
    if (child.type !== 'paragraph') continue
    const text = flattenPhrasing(child.children)
    if (text !== '') parts.push(text)
  }
  return parts.join(' ')
}

function projectListItem(item: ListItem, depth: number, sourceHash: string, current: WorkspaceChecklistSection): void {
  // A GFM task list item carries a boolean `checked`; plain bullets leave it undefined.
  if (typeof item.checked === 'boolean') {
    const line = item.position?.start.line ?? 0
    const row: WorkspaceChecklistItem = {
      key: `${sourceHash}:${line}`,
      text: itemText(item),
      checked: item.checked,
      line,
      depth,
    }
    current.items.push(row)
  }
  for (const child of item.children) {
    if (child.type !== 'list') continue
    for (const nested of child.children) projectListItem(nested, depth + 1, sourceHash, current)
  }
}

/**
 * Projects a tasks artifact's Markdown into sections and task items, in
 * source order. `sourceHash` is the source content hash (the reader's
 * sha256); every key is local to it and the item's source line.
 */
export function projectChecklist(markdown: string, sourceHash: string): WorkspaceChecklist {
  const tree = parser.parse(markdown)
  const sections: WorkspaceChecklistSection[] = []
  let current: WorkspaceChecklistSection | null = null
  const visit = (node: RootContent): void => {
    if (node.type === 'heading') {
      current = { heading: flattenPhrasing(node.children), depth: node.depth, items: [] }
      sections.push(current)
      return
    }
    if (node.type === 'list' && current !== null) {
      for (const item of node.children) projectListItem(item, 1, sourceHash, current)
    }
    // Everything else (code, paragraph, html, blockquote…) projects nothing:
    // fenced examples are inert, and items before the first heading are not
    // projected (stated in the module doc).
  }
  for (const child of tree.children) visit(child)
  return { sourceHash, sections }
}

// SectionHeader.tsx - Collapsible section header for the sectioned
// workspace navigator. Change sections show the change name, canonical
// progress, and a missing-in-worktree indication; worktree sections show
// repository, branch or detached revision, path, and dirty/stale state.
// Both carry attention counts, a collapse control, and accessible labels.
// Purely presentational; collapse state lives in the workspace store.
// CollapseTrigger is exported for the fallback (Workspace/Remote) section
// headers, which share the same chevron/aria-expanded/label contract.

import ChevronDownIcon from '@untitledui-icons/react/line/esm/ChevronDownIcon'
import ChevronRightIcon from '@untitledui-icons/react/line/esm/ChevronRightIcon'
import HandIcon from '@untitledui-icons/react/line/esm/HandIcon'
import { shortRevision } from '@shared/workspace'
import { getPathLeaf } from '../utils/sessionLabel'
import type { ChangeSectionData, WorktreeSectionData } from '../utils/workspaceView'

export interface SectionHeaderProps {
  section: ChangeSectionData | WorktreeSectionData
  onToggleCollapse: (sectionKey: string) => void
  /** Rendered at the trailing edge (e.g. the section's new-session action). */
  actions?: React.ReactNode
}

export default function SectionHeader({
  section,
  onToggleCollapse,
  actions,
}: SectionHeaderProps) {
  const hiddenAttention = section.hiddenAttentionCount
  const attentionTotal = section.attentionCount + hiddenAttention

  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1.5 text-left"
      data-testid="section-header"
      data-section-kind={section.kind}
      data-section-key={section.key}
      data-repository={section.repositoryName}
      data-collapsed={section.collapsed ? 'true' : 'false'}
      data-session-count={section.entries.length}
      data-attention-count={attentionTotal}
      data-hidden-attention-count={hiddenAttention}
    >
      <CollapseTrigger
        sectionKey={section.key}
        collapsed={section.collapsed}
        onToggleCollapse={onToggleCollapse}
        label={collapseLabel(section)}
        title={sectionTitle(section)}
      >
        {section.kind === 'change' ? (
          <ChangeHeaderIdentity section={section} />
        ) : (
          <WorktreeHeaderIdentity section={section} />
        )}
      </CollapseTrigger>

      {attentionTotal > 0 && (
        <span
          className="flex shrink-0 items-center gap-0.5 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-600"
          title="Sessions waiting for permission"
          aria-label={`${attentionTotal} session(s) need permission`}
          data-testid="section-attention-badge"
        >
          <HandIcon className="h-3 w-3" />
          {attentionTotal}
        </span>
      )}

      <span
        className="w-6 shrink-0 text-right text-[11px] tabular-nums text-muted"
        aria-label={`${section.entries.length} session(s)`}
      >
        {section.entries.length}
      </span>

      {actions}
    </div>
  )
}

/**
 * The collapse affordance shared by every section header: a chevron button
 * carrying aria-expanded, the accessible label, and the section's identity
 * for the toggle callback. Children render as the header's identity.
 */
export function CollapseTrigger({
  sectionKey,
  collapsed,
  onToggleCollapse,
  label,
  title,
  children,
}: {
  sectionKey: string
  collapsed: boolean
  onToggleCollapse: (sectionKey: string) => void
  label: string
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={() => onToggleCollapse(sectionKey)}
      className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-xs font-medium text-secondary hover:text-primary"
      aria-expanded={!collapsed}
      aria-label={label}
      title={title}
    >
      {collapsed ? (
        <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
      ) : (
        <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
      )}
      {children}
    </button>
  )
}

function ChangeHeaderIdentity({ section }: { section: ChangeSectionData }) {
  const { change } = section
  const hasProgress =
    change.completedTasks !== undefined && change.totalTasks !== undefined
  return (
    <>
      <span className="truncate font-semibold" data-testid="change-name">
        {change.name}
      </span>
      {hasProgress && (
        <span
          className="shrink-0 rounded bg-accent/10 px-1 font-mono text-[11px] text-accent"
          title={`Canonical progress from ${
            change.source === 'worktree' ? 'the change worktree' : 'the main worktree registry'
          }`}
          data-testid="change-progress"
        >
          {change.completedTasks}/{change.totalTasks}
        </span>
      )}
      <span className="truncate text-[11px] text-muted" title={section.repositoryName}>
        {section.repositoryName}
      </span>
      {change.missingInWorktree && (
        <span
          className="shrink-0 rounded bg-amber-500/20 px-1 text-[10px] uppercase tracking-wide text-amber-600"
          title={`The worktree ${change.worktreePath} does not contain this change`}
          data-testid="change-missing-in-worktree"
        >
          not in worktree
        </span>
      )}
      {section.repositoryStale && (
        <span
          className="shrink-0 rounded bg-zinc-500/20 px-1 text-[10px] uppercase tracking-wide text-zinc-400"
          title={section.repositoryError ?? 'Git discovery failed; showing last known state'}
        >
          stale
        </span>
      )}
    </>
  )
}

function WorktreeHeaderIdentity({ section }: { section: WorktreeSectionData }) {
  // Branch is absent exactly when HEAD is detached; fall back defensively so
  // the header never renders an empty identity.
  const isDetached = section.detached || !section.branch
  const identityLabel = isDetached ? `@${shortRevision(section.headRevision)}` : section.branch!
  const identityTitle = isDetached
    ? `Detached HEAD at ${section.headRevision}`
    : `Branch ${section.branch}`

  // The repository name comes from the main worktree's directory, so the path
  // leaf only adds information for linked worktrees.
  const pathLeaf = getPathLeaf(section.worktreePath)
  const showPath = pathLeaf !== null && pathLeaf !== section.repositoryName

  return (
    <>
      <span className="truncate font-semibold">{section.repositoryName}</span>
      <span
        className={`min-w-0 shrink truncate font-mono text-[11px] ${
          isDetached ? 'text-amber-500' : 'text-accent'
        }`}
        title={identityTitle}
      >
        {identityLabel}
      </span>
      {showPath && (
        <span className="truncate text-[11px] text-muted" title={section.worktreePath}>
          {pathLeaf}
        </span>
      )}
      {section.dirty && (
        <span
          className="shrink-0 rounded bg-amber-500/20 px-1 text-[10px] uppercase tracking-wide text-amber-600"
          title="Working tree has tracked or untracked changes"
        >
          dirty
        </span>
      )}
      {section.repositoryStale && (
        <span
          className="shrink-0 rounded bg-zinc-500/20 px-1 text-[10px] uppercase tracking-wide text-zinc-400"
          title={section.repositoryError ?? 'Git discovery failed; showing last known state'}
        >
          stale
        </span>
      )}
      <SrOnlyStateLabels
        labels={[
          ...(section.dirty ? ['dirty'] : []),
          ...(section.repositoryStale ? ['stale'] : []),
          ...(isDetached ? ['detached'] : []),
        ]}
      />
    </>
  )
}

function SrOnlyStateLabels({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null
  return <span className="sr-only">{` (${labels.join(', ')})`}</span>
}

function collapseLabel(section: ChangeSectionData | WorktreeSectionData): string {
  const verb = section.collapsed ? 'Expand' : 'Collapse'
  return section.kind === 'change'
    ? `${verb} change ${section.change.name} in ${section.repositoryName}`
    : `${verb} ${section.repositoryName} worktree ${
        (section as WorktreeSectionData).worktreePath
      }`
}

function sectionTitle(section: ChangeSectionData | WorktreeSectionData): string {
  return section.kind === 'change'
    ? section.change.worktreePath ?? `${section.repositoryName}: ${section.change.name}`
    : (section as WorktreeSectionData).worktreePath
}

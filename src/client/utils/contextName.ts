// contextName.ts - The current context's name (chat-context-name D2): the
// repository a Team route or the displayed session belongs to, and the
// navigator heading and browser title derived from it. One derivation feeds
// both labels, so they never disagree. Repository ownership comes from
// `owningRepository`, the rule team keys use.
import type { WorkspaceRepository } from '@shared/workspace'
import { owningRepository } from './teamKey'

/** The session the pane shows, reduced to what naming needs. */
export interface ContextSession {
  projectPath: string
  /** A session from another host: its path never resolves locally. */
  remote: boolean
}

export interface ContextNameInput {
  /** The Team route's key, when a Team page is shown. */
  teamKey?: string | null
  session?: ContextSession | null
  repositories?: readonly WorkspaceRepository[] | null
}

/** The final non-empty `/`-separated component, or null for `/`, empty, or absent. */
export function finalPathComponent(path?: string | null): string | null {
  return path?.split('/').filter(Boolean).at(-1) ?? null
}

const localName = (path: string, repositories: ContextNameInput['repositories']): string | null =>
  owningRepository(path, repositories)?.name ?? finalPathComponent(path)

/**
 * The context name: the Team route's repository, else the displayed session's
 * repository (a remote session uses its directory name), else null.
 */
export function contextName({ teamKey, session, repositories }: ContextNameInput): string | null {
  if (teamKey) return localName(teamKey, repositories)
  if (!session) return null
  return session.remote ? finalPathComponent(session.projectPath) : localName(session.projectPath, repositories)
}

export interface BrandLabels {
  /** The navigator heading text. */
  heading: string
  /** The browser title. */
  title: string
}

/** The heading and title for a context name, falling back to the server workspace name. */
export function brandLabels(context: string | null, workspaceName: string | null): BrandLabels {
  const name = context || workspaceName
  return name ? { heading: name, title: `${name} - Kawai` } : { heading: 'KAWAI', title: 'Kawai' }
}

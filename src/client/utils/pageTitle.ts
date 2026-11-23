// pageTitle.ts - The server workspace name (instance-identity): the final
// component of the configured default project directory, else of the server
// working directory. It is the labels' fallback when there is no context
// name (chat-context-name D2).
import { brandLabels, finalPathComponent } from './contextName'

export interface ServerDirectories {
  defaultProjectDir?: string | null
  cwd?: string | null
}

/** The server workspace name, independent of browser and session defaults; null when nameless. */
export function workspaceName(info?: ServerDirectories | null): string | null {
  return finalPathComponent(info?.defaultProjectDir) || finalPathComponent(info?.cwd)
}

/** The instance title: `<workspace name> - Kawai`, else `Kawai`. */
export function pageTitle(info?: ServerDirectories | null): string {
  return brandLabels(null, workspaceName(info)).title
}

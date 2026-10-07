// Public profile metadata and validation for session-create profile inputs.
// The catalog is resolved for the request's project path, so a `.kawai`
// directory in the project (or anywhere above it) extends the picker; `~`
// paths expand to the server home. File failures ride along as `errors` so
// invalid catalog files are reported, not silently skipped.
import { Hono } from 'hono'
import { claudeProfileCatalog, claudeProfileMetadata, type ProfileCatalogContext } from '../chat/ClaudeProfiles'

function catalogContext(projectPath: unknown): ProfileCatalogContext {
  if (typeof projectPath !== 'string') return {}
  const trimmed = projectPath.trim()
  return trimmed ? { projectPath: trimmed } : {}
}

export function createClaudeProfileRoutes() {
  const routes = new Hono()
  routes.get('/', c => c.json(claudeProfileCatalog(catalogContext(c.req.query('projectPath')))))
  return routes
}

export function profileRequestError(message: Record<string, unknown>): string | null {
  if (message.kind !== 'chat') {
    return message.claudeProfileId !== undefined ? 'Claude profiles apply only to chat sessions.' : null
  }
  if (['env', 'providerEnv', 'settings', 'model', 'command', 'executable', 'claudeExecutablePath', 'pathToClaudeCodeExecutable'].some(key => message[key] !== undefined)) {
    return 'Choose a Claude profile by identifier; custom environment, executables, model, settings, or commands are not accepted.'
  }
  if (message.claudeProfileId !== undefined && !claudeProfileMetadata(catalogContext(message.projectPath)).some(profile => profile.id === message.claudeProfileId)) {
    return `Unknown Claude profile "${String(message.claudeProfileId)}".`
  }
  return null
}

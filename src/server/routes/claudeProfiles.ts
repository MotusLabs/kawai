// Public profile metadata and validation for session-create profile inputs.
import { Hono } from 'hono'
import { claudeProfileMetadata } from '../chat/ClaudeProfiles'

export function createClaudeProfileRoutes() {
  const routes = new Hono()
  routes.get('/', c => c.json(claudeProfileMetadata()))
  return routes
}

export function profileRequestError(message: Record<string, unknown>): string | null {
  if (message.kind !== 'chat') {
    return message.claudeProfileId !== undefined ? 'Claude profiles apply only to chat sessions.' : null
  }
  if (['env', 'providerEnv', 'settings', 'model', 'command'].some(key => message[key] !== undefined)) {
    return 'Choose a Claude profile by identifier; custom environment, model, settings, or commands are not accepted.'
  }
  if (message.claudeProfileId !== undefined && !claudeProfileMetadata().some(profile => profile.id === message.claudeProfileId)) {
    return `Unknown Claude profile "${String(message.claudeProfileId)}".`
  }
  return null
}

// Probe the SDK control handshake without sending a model turn. Abort bounds
// startup time and closes the temporary process on both success and failure.
// The probe runs under the same provider environment as real chat spawns, so
// it cannot pass against one endpoint while sessions use another.
import { buildChatOptionsEnv, type ChatProviderEnv } from './chatProviderEnv'
import { TurnQueue } from './TurnQueue'
export async function probeSdkAvailability(providerEnv: ChatProviderEnv = {}): Promise<void> {
  const env = buildChatOptionsEnv(providerEnv)
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  const prompt = new TurnQueue()
  const stream = sdk.query({
    prompt,
    options: {
      abortController: controller,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      permissionMode: 'default',
      canUseTool: async () => ({ behavior: 'deny', message: 'Runtime availability probe' }),
      ...(env ? { env } : {}),
    },
  })
  try {
    await stream.initializationResult()
  } finally {
    clearTimeout(timer)
    controller.abort()
    prompt.end()
    stream.close()
  }
}

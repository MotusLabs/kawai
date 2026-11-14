// The actionable refusal shown when a Codex chat's profile has no usable
// login (codex-chat-sessions 4.2, spec "Codex sessions require a Codex
// login"). The structural check itself is the package's public
// `hasCodexLogin` (`@motuslabs/agent-runtime/codex`): a Codex home is usable
// when its auth.json carries an API key or ChatGPT tokens. The refusal and
// the profile's home resolution stay Kawai's (task-ce05430a R2 A5).

/**
 * Actionable refusal shown when hasCodexLogin() is false. It names the
 * PROFILE whose home has no login — never the home path, which is
 * trusted-tier filesystem layout and stays on the server (lead decision N1;
 * claude-session-profiles' "The Codex home SHALL NOT be sent to browsers"
 * stands). The path reaches only the server log, through the manager's
 * refusal helper.
 */
export function codexLoginErrorMessage(profile: string): string {
  return (
    `Codex profile "${profile}" has no usable login in its Codex home. ` +
    'Sign in with `codex login` (ChatGPT plan or API key), then retry.'
  )
}

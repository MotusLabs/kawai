import { readFileSync } from 'node:fs'
import { releaseErrors } from './agent-runtime-release-gate.js'

const runtime = JSON.parse(readFileSync('packages/agent-runtime/package.json', 'utf8')) as { version: string }
const companion = JSON.parse(readFileSync('packages/claude-agent-sdk-no-cli/package.json', 'utf8')) as { version: string }
const errors = releaseErrors({
  event: process.env.GITHUB_EVENT_NAME ?? '',
  ref: process.env.GITHUB_REF ?? '',
  sha: process.env.GITHUB_SHA ?? '',
  version: runtime.version,
  companionVersion: companion.version,
  changelog: readFileSync('packages/agent-runtime/CHANGELOG.md', 'utf8'),
  checks: process.env.REQUIRED_CHECKS ?? '',
  acceptedSha: process.env.ACCEPTED_SHA ?? '',
  nativeSha: process.env.NATIVE_SHA ?? '',
  authorizedSha: process.env.AUTHORIZED_SHA ?? '',
})
if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else console.log(`Eligible source ${process.env.GITHUB_SHA}; publication remains a separate job`)

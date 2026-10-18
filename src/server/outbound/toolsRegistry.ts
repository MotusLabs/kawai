// The `registry-publish` rule (execution-safety-recovery D4): npm, pnpm,
// yarn, bun, twine, cargo, docker, podman, buildx, buildctl, and helm, each
// against its option table. Every image a push names is judged — each `-t`
// tag and every name of a pushing `--output` — and an output whose parts do
// not all read as `key=value` fails the shape check rather than guessing. A
// registry given by name (`cargo --registry x`, `twine -r x`) resolves only
// through config the parser does not read, so it fails the facts check. A
// tool's other subcommands are the backstop's, except the listed reads.
// Pure.
import { hasOption, merge, scanOptions, table, valuesOf, type OptionTable } from './options'
import { NON_SEND, UNMODELED, unresolved, type FailureCode, type RuleInput, type RuleResult, type RuleSend } from './proof'
import { defaultRegistry, imageTarget, registryFlagTarget } from './targets'
import type { Word } from './tokenize'

const publish = (target: RuleSend['target'], failures: FailureCode[]): RuleSend => ({ rule: 'registry-publish', target, failures: [...failures] })

const NPM = table(
  '--dry-run --provenance --ignore-scripts --workspaces -ws --include-workspace-root -q --quiet -s --silent --json --foreground-scripts ' +
  '--no-git-checks -r --recursive --force -f --report-summary --no-provenance -y --yes',
  '--registry --tag --access --otp -w --workspace --loglevel --filter --publish-branch --cwd',
)

/** `npm|pnpm|bun publish`, `yarn publish`, `yarn npm publish`. */
export function npmRule(input: RuleInput): RuleResult {
  const scanned = scanOptions(input.args, 0, NPM)
  const words = scanned.positionals.map(word => word.text)
  const publishes = words[0] === 'publish' || (input.name === 'yarn' && words[0] === 'npm' && words[1] === 'publish')
  if (!publishes) return input.args.some(word => word.text === 'publish') ? UNMODELED : unmodeledUnlessRead(input)
  const failures: FailureCode[] = []
  if (scanned.unknown !== null) failures.push('unknown-option')
  if (scanned.opaque) failures.push('not-literal')
  if (hasOption(scanned, '--cwd')) failures.push('inexact-cwd')
  const registry = valuesOf(scanned, '--registry')[0]
  return { kind: 'sends', sends: [publish(registry === undefined ? defaultRegistry(input.name) : registryFlagTarget(registry), failures)] }
}

/** Package-manager reads that run no script and send nothing. */
const NPM_READS = new Set(['view', 'info', 'show', 'ls', 'list', 'outdated', 'why', 'search', 'whoami', 'config', 'help', '--version', '-v', 'version'])
function unmodeledUnlessRead(input: RuleInput): RuleResult {
  const first = input.args[0]
  return first !== undefined && first.literal && NPM_READS.has(first.text) && input.args.length === 1 ? NON_SEND : UNMODELED
}

const TWINE = table(
  '--non-interactive --skip-existing -s --sign --verbose --disable-progress-bar --attestations',
  '-r --repository --repository-url -u --username -p --password --sign-with -i --identity -c --comment --config-file --cert --client-cert',
)

export function twineRule(input: RuleInput): RuleResult {
  const scanned = scanOptions(input.args, 0, TWINE)
  if (scanned.positionals[0]?.text !== 'upload') return scanned.positionals[0]?.text === 'check' && scanned.unknown === null ? NON_SEND : UNMODELED
  const failures: FailureCode[] = []
  if (scanned.unknown !== null) failures.push('unknown-option')
  if (hasOption(scanned, '--config-file')) failures.push('options-file')
  const url = valuesOf(scanned, '--repository-url')[0]
  const named = valuesOf(scanned, '-r', '--repository')[0]
  const target = url !== undefined ? registryFlagTarget(url)
    : named !== undefined ? (/^[a-z][a-z0-9+.-]*:\/\//i.test(named.text) ? registryFlagTarget(named) : unresolved('registry-name'))
      : defaultRegistry('twine')
  return { kind: 'sends', sends: [publish(target, failures)] }
}

const CARGO = table(
  '--dry-run --allow-dirty --no-verify --all-features --no-default-features --locked --offline --frozen -v --verbose -q --quiet --keep-going',
  '--registry --index --token -p --package --manifest-path --target --target-dir -F --features -j --jobs --color',
)

export function cargoRule(input: RuleInput): RuleResult {
  const start = input.args[0]?.text.startsWith('+') === true ? 1 : 0
  const scanned = scanOptions(input.args, start, CARGO)
  // Other cargo commands run build scripts: the backstop's.
  if (scanned.positionals[0]?.text !== 'publish') return UNMODELED
  const failures: FailureCode[] = []
  if (scanned.unknown !== null) failures.push('unknown-option')
  if (hasOption(scanned, '--manifest-path')) failures.push('inexact-cwd')
  const index = valuesOf(scanned, '--index')[0]
  const target = index !== undefined ? registryFlagTarget(index) : hasOption(scanned, '--registry') ? unresolved('registry-name') : defaultRegistry('cargo')
  return { kind: 'sends', sends: [publish(target, failures)] }
}

const DOCKER_GLOBAL = table(
  '-D --debug --tls --tlsverify -v --version',
  '--config -c --context -H --host -l --log-level --tlscacert --tlscert --tlskey',
)
const DOCKER_PUSH = table('-a --all-tags --disable-content-trust -q --quiet', '--platform')
const PODMAN_PUSH = table(
  '--compress --disable-content-trust -q --quiet --remove-signatures --force-compression',
  '--authfile --cert-dir --creds --digestfile -f --format --sign-by --retry --retry-delay --compression-format --compression-level --encryption-key --sign-passphrase-file',
  '--tls-verify',
)
const BUILD = table(
  '--no-cache --pull -q --quiet --push --load --rm --force-rm --squash --compress -D --debug --check',
  '-t --tag -f --file --build-arg --target --platform --progress --label --secret --ssh --cache-from --cache-to -o --output ' +
  '--builder --network --add-host --iidfile --metadata-file --build-context --shm-size --ulimit --isolation -m --memory ' +
  '--cpu-shares --cpuset-cpus --annotation --attest --call --allow --cgroup-parent --no-cache-filter',
  '--provenance --sbom',
)
/** Docker subcommands that never push. */
const DOCKER_READS = new Set(['ps', 'images', 'image', 'inspect', 'logs', 'version', 'info', 'pull', 'tag', 'stop', 'rm', 'rmi', 'start', 'restart', 'kill', 'top', 'stats', 'history', 'save', 'load', 'network', 'volume', 'search', 'context', 'system'])

/** The images a pushing build sends to: every tag, every output name; null when it does not push. */
function buildPushes(tool: string, words: Word[], start: number): RuleSend[] | null {
  const scanned = scanOptions(words, start, BUILD, false, true)
  const failures: FailureCode[] = []
  if (scanned.unknown !== null) return null
  if (scanned.opaque) failures.push('not-literal')
  if (scanned.positionals.length > 1) failures.push('extra-argument')
  const names: string[] = []
  let pushes = scanned.options.some(option => option.name === '--push' && option.value?.text !== 'false')
  for (const output of valuesOf(scanned, '-o', '--output')) {
    const parts = output.text.split(',')
    if (parts.some(part => !/^[a-z-]+=[^"']*$/i.test(part)) || output.text.includes('"')) {
      if (/push|registry/i.test(output.text)) { pushes = true; failures.push('unparsed-output') }
      continue
    }
    const fields = parts.map(part => [part.slice(0, part.indexOf('=')).toLowerCase(), part.slice(part.indexOf('=') + 1)] as const)
    const pushing = fields.some(([key, value]) => (key === 'push' && /^(true|1)$/i.test(value)) || (key === 'type' && value === 'registry'))
    if (!pushing) continue
    pushes = true
    for (const [key, value] of fields) if (key === 'name') names.push(value)
  }
  if (!pushes) return null
  names.push(...valuesOf(scanned, '-t', '--tag').map(word => word.text))
  if (names.length === 0) return [publish(defaultRegistry(tool), [...failures, 'unparsed-output'])]
  return names.map(name => publish(imageTarget(tool, name), failures))
}

export function dockerRule(input: RuleInput): RuleResult {
  const { name, args } = input
  const global = scanOptions(args, 0, DOCKER_GLOBAL, true, true)
  if (global.unknown !== null || global.opaque) return UNMODELED
  const sub = args[global.end]
  if (sub === undefined) return NON_SEND
  if (!sub.literal) return UNMODELED
  let at = global.end + 1
  let verb = sub.text
  if (verb === 'image' && args[at]?.text === 'push') { verb = 'push'; at++ }
  if (verb === 'push') return pushRule(name, args, at, name === 'podman' ? PODMAN_PUSH : DOCKER_PUSH)
  if (verb === 'build' || (verb === 'buildx' && args[at]?.text === 'build') || (verb === 'builder' && args[at]?.text === 'build')) {
    const sends = buildPushes(name, args, verb === 'build' ? at : at + 1)
    if (sends !== null) return { kind: 'sends', sends }
    // An unknown option may be a push spelling the table does not list.
    return scanOptions(args, verb === 'build' ? at : at + 1, BUILD, false, true).unknown === null && args.every(word => word.literal) ? NON_SEND : UNMODELED
  }
  return DOCKER_READS.has(verb) && args.every(word => word.literal) ? NON_SEND : UNMODELED
}

function pushRule(tool: string, args: Word[], at: number, options: OptionTable): RuleResult {
  const scanned = scanOptions(args, at, options, false, true)
  const failures: FailureCode[] = []
  if (scanned.unknown !== null) failures.push('unknown-option')
  if (scanned.opaque) failures.push('not-literal')
  const [image, destination, ...extra] = scanned.positionals
  // podman's second positional is the destination; docker takes one image.
  if (extra.length > 0 || (tool !== 'podman' && destination !== undefined)) failures.push('extra-argument')
  const reference = tool === 'podman' && destination !== undefined ? destination : image
  if (reference === undefined) return { kind: 'sends', sends: [publish(unresolved('target-not-url'), failures)] }
  if (tool === 'podman' && /^[a-z-]+:/.test(reference.text) && !reference.text.startsWith('docker://')) {
    return { kind: 'sends', sends: [publish(unresolved('target-not-url'), failures)] }
  }
  return { kind: 'sends', sends: [publish(imageTarget(tool, reference.text), failures)] }
}

const BUILDCTL_GLOBAL = table('--debug', '--addr --tlsservername --tlscacert --tlscert --tlskey --tlsdir --timeout --wait')
const BUILDCTL_BUILD = table(
  '--no-cache',
  '--frontend --opt --local --output -o --progress --trace --export-cache --import-cache --secret --ssh --allow --metadata-file --ref-file --source-policy-file',
)

export function buildctlRule(input: RuleInput): RuleResult {
  const global = scanOptions(input.args, 0, BUILDCTL_GLOBAL, true)
  if (global.unknown !== null || input.args[global.end]?.text !== 'build') return UNMODELED
  const scanned = scanOptions(input.args, global.end + 1, BUILDCTL_BUILD)
  if (scanned.unknown !== null) return UNMODELED
  // buildctl's `--output` shares the build table's parsing.
  const outputs = valuesOf(scanned, '--output', '-o').flatMap(word => [{ ...word, text: '--output' }, word])
  const sends = buildPushes('buildctl', outputs, 0)
  return sends === null ? NON_SEND : { kind: 'sends', sends }
}

const HELM_GLOBAL = table('--debug', '--kube-context --kubeconfig -n --namespace --registry-config --repository-cache --repository-config --burst-limit --qps')
const HELM_PUSH = table('--insecure-skip-tls-verify --plain-http --password-stdin', '--ca-file --cert-file --key-file --username --password')

export function helmRule(input: RuleInput): RuleResult {
  const global = scanOptions(input.args, 0, HELM_GLOBAL, true, true)
  if (global.unknown !== null || input.args[global.end]?.text !== 'push') return UNMODELED
  const scanned = scanOptions(input.args, global.end + 1, merge(HELM_GLOBAL, HELM_PUSH), false, true)
  const failures: FailureCode[] = []
  if (scanned.unknown !== null) failures.push('unknown-option')
  const [, remote, ...extra] = scanned.positionals
  if (extra.length > 0) failures.push('extra-argument')
  if (remote === undefined || !/^(oci|https?):\/\//.test(remote.text)) return { kind: 'sends', sends: [publish(unresolved('target-not-url'), failures)] }
  return { kind: 'sends', sends: [publish(registryFlagTarget(remote), failures)] }
}

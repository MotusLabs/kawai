// The `http-send` and `mail-send` rules (execution-safety-recovery D4):
// curl, wget, and httpie read against their option tables. A request sends
// when it has a body or a method other than GET/HEAD; every URL argument is
// judged, so a second URL is never cover for the first. A plain GET is a
// proven non-send only when every option is known and every URL is http(s)
// or a bare host: other schemes (gopher, telnet, dict, …) can carry data in
// the URL itself. Proxy, resolve, and socket options redirect the connection
// and fail the facts check; a config or input file (`-K`, `-e`, `-i`) fails
// the shape check. Pure.
import { hasOption, scanOptions, table, valuesOf } from './options'
import { NON_SEND, UNMODELED, type FailureCode, type RuleInput, type RuleResult, type RuleSend } from './proof'
import { httpUrlTarget, schemeOf } from './targets'
import type { Word } from './tokenize'

const CURL = table(
  '-s --silent -S --show-error -f --fail --fail-with-body --fail-early -L --location --location-trusted -i --include -I --head ' +
  '-v --verbose -k --insecure -G --get -g --globoff -N --no-buffer -O --remote-name --remote-name-all -J --remote-header-name ' +
  '--compressed -# --progress-bar --no-progress-meter -q --disable --http1.0 -0 --http1.1 --http2 --http2-prior-knowledge --http3 ' +
  '--tlsv1 --tlsv1.0 --tlsv1.1 --tlsv1.2 --tlsv1.3 --ssl --ssl-reqd -4 --ipv4 -6 --ipv6 --create-dirs --raw --tr-encoding ' +
  '--no-keepalive --path-as-is --retry-all-errors --retry-connrefused -Z --parallel -R --remote-time -l --list-only -a --append ' +
  '-B --use-ascii -j --junk-session-cookies --digest --basic --ntlm --anyauth --negotiate -M --manual -V --version --no-sessionid ' +
  '--styled-output --no-styled-output --ssl-no-revoke --false-start --tcp-nodelay --tcp-fastopen --suppress-connect-headers -n --netrc --netrc-optional',
  '-X --request -d --data --data-raw --data-binary --data-ascii --data-urlencode -F --form --form-string -T --upload-file --url ' +
  '-u --user -H --header -o --output -A --user-agent -b --cookie -c --cookie-jar -e --referer -E --cert --cert-type --key --key-type ' +
  '--cacert --capath -m --max-time --connect-timeout --retry --retry-delay --retry-max-time -w --write-out -D --dump-header ' +
  '-r --range -C --continue-at -y --speed-time -Y --speed-limit --limit-rate --max-redirs --max-filesize --json --oauth2-bearer ' +
  '--stderr --trace --trace-ascii --output-dir --interface --local-port --dns-servers --doh-url --proto --proto-redir --url-query ' +
  '-z --time-cond --request-target --tls-max --ciphers --pinnedpubkey --mail-from --mail-rcpt --mail-auth --netrc-file ' +
  '--keepalive-time --expect100-timeout --happy-eyeballs-timeout-ms --create-file-mode --noproxy ' +
  '-K --config -x --proxy -U --proxy-user --preproxy --socks4 --socks4a --socks5 --socks5-hostname --resolve --connect-to ' +
  '--unix-socket --abstract-unix-socket --proxy-header',
  '-h --help',
)
const CURL_BODY = ['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '-F', '--form', '--form-string', '-T', '--upload-file', '--json']
const CURL_REDIRECT = ['-x', '--proxy', '-U', '--proxy-user', '--preproxy', '--socks4', '--socks4a', '--socks5', '--socks5-hostname', '--resolve', '--connect-to', '--unix-socket', '--abstract-unix-socket', '--proxy-header']

const WGET = table(
  '-q --quiet -v --verbose -c --continue -N --timestamping -r --recursive -k --convert-links -p --page-requisites -m --mirror ' +
  '-S --server-response --spider -x --force-directories --no-check-certificate -4 -6 --inet4-only --inet6-only -b --background ' +
  '--content-disposition --trust-server-names -E --adjust-extension -H --span-hosts -L --relative --no-cookies --ignore-length ' +
  '--no-http-keep-alive --show-progress --auth-no-challenge --https-only --no-proxy -V --version -h --help -F --force-html ' +
  '--no-verbose --no-clobber --no-parent --no-directories --no-host-directories --random-wait --keep-session-cookies',
  '-O --output-document -o --output-file -a --append-output -P --directory-prefix -t --tries -T --timeout -w --wait -l --level ' +
  '-U --user-agent --header --user --password --http-user --http-password --post-data --post-file --method --body-data --body-file ' +
  '-A --accept -R --reject -D --domains --referer --limit-rate -Q --quota --load-cookies --save-cookies --ca-certificate ' +
  '--certificate --private-key --bind-address --dns-timeout --connect-timeout --read-timeout --waitretry --restrict-file-names ' +
  '--max-redirect --compression -n -i --input-file -e --execute --config --proxy-user --proxy-password',
)
const WGET_BODY = ['--post-data', '--post-file', '--body-data', '--body-file']

const HTTPIE = table(
  '-j --json -f --form --multipart -h --headers -b --body -v --verbose --all -S --stream -d --download -c --continue -q --quiet ' +
  '--offline --check-status --follow -F --ignore-stdin -I --chunked -x --compress --path-as-is --unsorted --sorted --debug --traceback',
  '--pretty -s --style -p --print -o --output --verify --timeout --session --session-read-only -a --auth -A --auth-type ' +
  '--proxy --max-redirects --default-scheme --cert --cert-key --ssl --ciphers --max-headers --response-charset --response-mime ' +
  '--format-options --raw --boundary',
)

const MAIL_TOOLS = new Set(['sendmail', 'msmtp', 'mailx', 'ssmtp'])

/** Every send to every URL, or a mail send when any URL is smtp. */
function sendsTo(urls: Array<Word | undefined>, failures: FailureCode[]): RuleResult {
  const targets = (urls.length > 0 ? urls : [undefined]).map(word => httpUrlTarget(word))
  if (targets.some(target => target.kind === 'mail')) return { kind: 'sends', sends: [{ rule: 'mail-send', target: { kind: 'mail' }, failures }] }
  const sends: RuleSend[] = targets.map(target => ({ rule: 'http-send', target, failures: [...failures] }))
  return { kind: 'sends', sends }
}

/** A GET whose every URL is plain http(s) is a proven read; anything else is the backstop's. */
function readOrUnmodeled(urls: Word[]): RuleResult {
  if (urls.length === 0) return NON_SEND
  return urls.every(word => /^(https?|file)$/.test(schemeOf(word.text))) ? NON_SEND : UNMODELED
}

export function curlRule(input: RuleInput): RuleResult {
  const scanned = scanOptions(input.args, 0, CURL)
  if (scanned.unknown !== null) return UNMODELED
  const urls = [...valuesOf(scanned, '--url'), ...scanned.positionals]
  const method = valuesOf(scanned, '-X', '--request')[0]
  const body = hasOption(scanned, ...CURL_BODY)
  const mail = hasOption(scanned, '--mail-rcpt', '--mail-from')
  const failures: FailureCode[] = []
  if (scanned.opaque || method?.literal === false) failures.push('not-literal')
  if (hasOption(scanned, '-K', '--config')) failures.push('options-file')
  if (!hasOption(scanned, '-g', '--globoff') && urls.some(word => /[{[]/.test(word.text))) failures.push('url-glob')
  if (hasOption(scanned, ...CURL_REDIRECT)) failures.push('connection-redirected')
  if (mail) return { kind: 'sends', sends: [{ rule: 'mail-send', target: { kind: 'mail' }, failures }] }
  const upper = method?.text.toUpperCase()
  const sends = (upper !== undefined && upper !== 'GET' && upper !== 'HEAD') || (body && !hasOption(scanned, '-G', '--get')) ||
    urls.some(word => /^smtps?$/.test(schemeOf(word.text)))
  if (sends) return sendsTo(urls, failures)
  // A config file or a redirected connection may send what the words do not show.
  if (failures.length > 0) return UNMODELED
  return readOrUnmodeled(urls)
}

export function wgetRule(input: RuleInput): RuleResult {
  const scanned = scanOptions(input.args, 0, WGET)
  if (scanned.unknown !== null) return UNMODELED
  const failures: FailureCode[] = []
  if (scanned.opaque) failures.push('not-literal')
  if (hasOption(scanned, '-i', '--input-file', '-e', '--execute', '--config')) failures.push('options-file')
  if (hasOption(scanned, '--proxy-user', '--proxy-password')) failures.push('connection-redirected')
  const method = valuesOf(scanned, '--method')[0]
  const upper = method?.text.toUpperCase()
  const sends = hasOption(scanned, ...WGET_BODY) || (upper !== undefined && upper !== 'GET' && upper !== 'HEAD')
  if (sends) return sendsTo(scanned.positionals, failures)
  if (failures.length > 0) return UNMODELED
  return readOrUnmodeled(scanned.positionals)
}

/** httpie: `[METHOD] URL [ITEM…]`; `name=v`, `name:=v`, `field@file` items are a body. */
export function httpieRule(input: RuleInput): RuleResult {
  const scanned = scanOptions(input.args, 0, HTTPIE)
  if (scanned.unknown !== null) return UNMODELED
  const failures: FailureCode[] = []
  if (scanned.opaque) failures.push('not-literal')
  if (hasOption(scanned, '--proxy')) failures.push('connection-redirected')
  if (hasOption(scanned, '--offline')) return NON_SEND
  const [first, second] = scanned.positionals
  // A leading all-letter word is the method only when the next word is no request item.
  const hasMethod = first !== undefined && second !== undefined && /^[A-Za-z]+$/.test(first.text) &&
    !/^[^:=@/]+(==|:=|=|@)/.test(second.text) && !/^[A-Za-z][\w-]*:(?!\/\/|\d)/.test(second.text)
  const method = hasMethod ? first.text.toUpperCase() : undefined
  const url = hasMethod ? second : first
  const items = scanned.positionals.slice(hasMethod ? 2 : 1)
  const body = items.some(word => /^[^:=@]*(:=|=(?!=)|@)/.test(word.text)) ||
    (input.stdin && !hasOption(scanned, '-I', '--ignore-stdin'))
  const sends = body || (method !== undefined && method !== 'GET' && method !== 'HEAD')
  const scheme = input.name === 'https' ? 'https' : 'http'
  const urlWord = url === undefined ? undefined : URL_OF(url, scheme)
  if (sends) return sendsTo(urlWord === undefined ? [] : [urlWord], failures)
  if (failures.length > 0) return UNMODELED
  return urlWord === undefined ? NON_SEND : readOrUnmodeled([urlWord])
}

/** httpie's shorthands: `:3000/x` is localhost, a bare host takes the command's scheme. */
function URL_OF(word: Word, scheme: string): Word {
  if (word.text.startsWith(':')) return { ...word, text: `${scheme}://localhost${word.text}` }
  return word
}

/** `sendmail`, `msmtp`, `mailx`, `ssmtp`, `mail -s`, `python -m smtpd`, `git send-email`. */
export function mailRule(input: RuleInput): RuleResult | null {
  const { name, args } = input
  const mail = (): RuleResult => ({ kind: 'sends', sends: [{ rule: 'mail-send', target: { kind: 'mail' }, failures: [] }] })
  if (MAIL_TOOLS.has(name)) return mail()
  // `mail <address>` sends whatever its stdin holds; `mail` alone or `-f` reads.
  if (name === 'mail') return args.some(word => !word.text.startsWith('-')) || args.some(word => word.text.startsWith('-s')) ? mail() : UNMODELED
  if (/^python[0-9.]*$/.test(name) && args[0]?.text === '-m' && args[1]?.text === 'smtpd') return mail()
  return null
}

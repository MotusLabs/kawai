/**
 * Owned-Git result-frame codec (dormant S1 module, change delivery-outcome-metrics).
 *
 * Pure, stateless syntax decoding of ONE supplied complete GIT_RESULT frame.
 * Supplied bytes only: raw byteLength <= 512 (JSON whitespace counted), a
 * leading UTF-8 BOM rejected without stripping, fatal UTF-8, one JSON object
 * with exactly the decoded unique top-level keys type/code/signal, and the
 * exit/signal tuple fixed by design.md "S1 acceptance oracles" (table
 * S1O01-S1O12, property S1P1). Every supplied-byte syntax failure returns
 * plain null; the decoder never throws or coerces.
 *
 * Syntax only: a valid return proves nothing about Git provenance, ordinary
 * exit, cleanup or delivery facts. HELLO/STARTED/once/order/CLOSING
 * validation belongs to future lifecycle owners. No local imports; no I/O;
 * no process, timer, holder or recovery machinery. Byte and code-point
 * literals are numeric so the source carries no escape sequences.
 */

export type GitResultFrame =
  | { type: 'GIT_RESULT'; code: number; signal: null }
  | { type: 'GIT_RESULT'; code: null; signal: string };

const MAX_FRAME_BYTES = 512;
const EXPECTED_KEYS = ['code', 'signal', 'type'];

const utf8 = new TextDecoder('utf-8', { fatal: true });

function isJsonWhitespace(unit: number): boolean {
  return unit === 0x20 || unit === 0x09 || unit === 0x0a || unit === 0x0d;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Full-string signal language: SIG[A-Z0-9]+ without multiline matching.
 * The regex already requires end-of-input. The last-unit exclusions below
 * are redundant and preserve that language; they do not fix a dollar-anchor
 * exception. No signal provenance or ordinary-return proof is inferred.
 */
function isFullSignalMatch(signal: string): boolean {
  if (!/^SIG[A-Z0-9]+$/.test(signal)) return false;
  const last = signal.charCodeAt(signal.length - 1);
  return last !== 0x0a && last !== 0x0d && last !== 0x2028 && last !== 0x2029;
}

interface ScannedString {
  value: string;
  next: number;
}

/**
 * Reads one JSON string token starting at a double quote. Returns the
 * decoded string (escapes resolved through JSON.parse, so unicode and
 * surrogate pairs match the grammar exactly) and the index just past the
 * closing quote, or null on a malformed token.
 */
function scanJsonString(text: string, start: number): ScannedString | null {
  const n = text.length;
  let i = start + 1;
  while (i < n) {
    const unit = text.charCodeAt(i);
    if (unit === 0x22) {
      const raw = text.slice(start, i + 1);
      try {
        const decoded: unknown = JSON.parse(raw);
        if (typeof decoded !== 'string') return null;
        return { value: decoded, next: i + 1 };
      } catch {
        return null;
      }
    }
    i += unit === 0x5c ? 2 : 1;
  }
  return null;
}

/**
 * Skips one complete JSON value. Returns the index just past it, or -1 when
 * the value is truncated or malformed. String- and nesting-aware, so
 * property-like substrings inside values are never taken as keys.
 */
function skipJsonValue(text: string, start: number): number {
  const n = text.length;
  let i = start;
  if (i >= n) return -1;
  const first = text.charCodeAt(i);
  if (first === 0x22) {
    const str = scanJsonString(text, i);
    return str === null ? -1 : str.next;
  }
  if (first === 0x7b || first === 0x5b) {
    let depth = 0;
    while (i < n) {
      const unit = text.charCodeAt(i);
      if (unit === 0x22) {
        const str = scanJsonString(text, i);
        if (str === null) return -1;
        i = str.next;
        continue;
      }
      if (unit === 0x7b || unit === 0x5b) {
        depth += 1;
        i += 1;
        continue;
      }
      if (unit === 0x7d || unit === 0x5d) {
        depth -= 1;
        i += 1;
        if (depth === 0) return i;
        continue;
      }
      i += 1;
    }
    return -1;
  }
  while (i < n) {
    const unit = text.charCodeAt(i);
    if (unit === 0x2c || unit === 0x7d || unit === 0x5d || isJsonWhitespace(unit)) return i;
    i += 1;
  }
  return n;
}

/**
 * Bounded key-aware scan of the top-level object. Returns the decoded member
 * names in order, or null when the scan cannot walk the text. Names are
 * decoded before comparison, so escaped-equal keys (code and its u0063
 * escape form) collide exactly like literal duplicates.
 */
function topLevelKeys(text: string): string[] | null {
  const n = text.length;
  let i = 0;
  const skipWhitespace = () => {
    while (i < n && isJsonWhitespace(text.charCodeAt(i))) i += 1;
  };
  skipWhitespace();
  if (i >= n || text.charCodeAt(i) !== 0x7b) return null;
  i += 1;
  skipWhitespace();
  const keys: string[] = [];
  if (i < n && text.charCodeAt(i) === 0x7d) return keys;
  for (;;) {
    skipWhitespace();
    if (i >= n || text.charCodeAt(i) !== 0x22) return null;
    const key = scanJsonString(text, i);
    if (key === null) return null;
    keys.push(key.value);
    i = key.next;
    skipWhitespace();
    if (i >= n || text.charCodeAt(i) !== 0x3a) return null;
    i += 1;
    skipWhitespace();
    i = skipJsonValue(text, i);
    if (i < 0) return null;
    skipWhitespace();
    if (i >= n) return null;
    const unit = text.charCodeAt(i);
    if (unit === 0x2c) {
      i += 1;
      continue;
    }
    if (unit === 0x7d) {
      i += 1;
      break;
    }
    return null;
  }
  skipWhitespace();
  if (i !== n) return null;
  return keys;
}

/**
 * Decodes ONE supplied complete GIT_RESULT frame. See design.md
 * "S1 acceptance oracles: dormant result-frame syntax" for the exact
 * contract and the S1O01-S1O12 oracle table.
 */
export function decodeGitResultFrame(bytes: Uint8Array): GitResultFrame | null {
  if (bytes.byteLength > MAX_FRAME_BYTES) return null;
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return null;
  }
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainJsonObject(parsed)) return null;
  if (Object.keys(parsed).length !== EXPECTED_KEYS.length) return null;
  const keys = topLevelKeys(text);
  if (keys === null) return null;
  if (keys.length !== EXPECTED_KEYS.length) return null;
  const sorted = [...keys].sort();
  for (let k = 0; k < EXPECTED_KEYS.length; k += 1) {
    if (sorted[k] !== EXPECTED_KEYS[k]) return null;
  }
  const typeValue = parsed['type'];
  const codeValue = parsed['code'];
  const signalValue = parsed['signal'];
  if (typeValue !== 'GIT_RESULT') return null;
  if (
    typeof codeValue === 'number' &&
    Number.isSafeInteger(codeValue) &&
    codeValue >= 0 &&
    codeValue <= 255 &&
    signalValue === null
  ) {
    return { type: 'GIT_RESULT', code: codeValue, signal: null };
  }
  if (codeValue === null && typeof signalValue === 'string' && isFullSignalMatch(signalValue)) {
    return { type: 'GIT_RESULT', code: null, signal: signalValue };
  }
  return null;
}

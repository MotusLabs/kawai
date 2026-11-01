/**
 * Dormant S1 tests for the owned-Git result-frame codec (change
 * delivery-outcome-metrics). Executable oracle rows S1O01-S1O11 and the
 * seeded property S1P1 from design.md "S1 acceptance oracles"; S1O12 is
 * documented below but never executed here (its guard-removal run is a
 * later, separately authorized change). Imports are exactly the actual
 * codec and bun:test. These helper tests carry no public-scenario coverage
 * annotation: syntax checks never prove provenance, ordinary exit, cleanup,
 * delivery facts or any public composition. The module is intentionally
 * dormant; no production caller exists. Fixture escapes are built with
 * String.fromCharCode(92) so the source carries no literal backslashes.
 */

import { describe, expect, test } from 'bun:test';
import { decodeGitResultFrame, type GitResultFrame } from '../git/ownedGitProtocol';

const BACKSLASH = String.fromCharCode(92);

/** One JSON u-escape, e.g. 0x63 gives the six characters backslash-u-0063. */
function esc(code: number): string {
  return BACKSLASH + 'u' + code.toString(16).padStart(4, '0');
}

const encoder = new TextEncoder();

function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

function numericFrame(code: number): Uint8Array {
  return bytesOf('{"type":"GIT_RESULT","code":' + String(code) + ',"signal":null}');
}

function signalFrame(name: string): Uint8Array {
  return bytesOf('{"type":"GIT_RESULT","code":null,"signal":"' + name + '"}');
}

function joinBytes(parts: Array<Uint8Array | number[]>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * One shared duplicate-code-pair row: an id naming the case identity and
 * the actual input bytes. Exactly one raw literal code key and one raw
 * escaped-equivalent code key (esc(0x63) is the JSON u-escape of code's
 * first letter), in the row's order, with equal (5/5) or unequal (5/6)
 * values in 0..255. Type is GIT_RESULT and signal is null, so under JSON
 * last-wins each row would decode to a valid numeric tuple; only
 * duplicate-key detection can return null.
 */
interface DupCodePairRow {
  id: string;
  input: Uint8Array;
}

function buildDupCodePairRow(escapedFirst: boolean, equal: boolean, id: string): DupCodePairRow {
  const first = escapedFirst ? esc(0x63) + 'ode' : 'code';
  const second = escapedFirst ? 'code' : esc(0x63) + 'ode';
  return {
    id,
    input: bytesOf('{"type":"GIT_RESULT","' + first + '":5,"' + second + '":' + (equal ? '5' : '6') + ',"signal":null}'),
  };
}

/**
 * THE shared four-row literal-vs-escaped matrix. Row order:
 * literal-first/equal, literal-first/unequal, escaped-first/equal,
 * escaped-first/unequal. Both the static S1O07 matrix and property
 * category5 consume these same constructed rows; the property's hit
 * counters are keyed by the returned row id, never by variant index.
 */
const DUP_CODE_PAIR_ROWS: DupCodePairRow[] = [
  buildDupCodePairRow(false, true, 'literal-first/equal'),
  buildDupCodePairRow(false, false, 'literal-first/unequal'),
  buildDupCodePairRow(true, true, 'escaped-first/equal'),
  buildDupCodePairRow(true, false, 'escaped-first/unequal'),
];

/**
 * One built S1P1 case. dupRowId is present exactly when input IS the bytes
 * of a shared DUP_CODE_PAIR_ROWS row; it carries that row's id so property
 * hit accounting can be tied to the actual constructed fixture.
 */
interface BuiltCase {
  input: Uint8Array;
  expected: GitResultFrame | null;
  dupRowId?: string;
}

/**
 * Builds one S1P1 case: the supplied bytes and the independently known
 * POST-ENCODING expectation, written by construction from the S1O oracle
 * table, never by the decoder or a copy of its predicate. Category schedule:
 * 0 valid numeric (code=s&255), 1 valid signal (TERM/KILL/USR2 cycle),
 * 2 invalid code, 3 invalid BOTHNULL/BOTHSET tuple, 4 literal duplicate,
 * 5 shared duplicate-code matrix rows, 6 invalid UTF-8, 7 malformed JSON (raw
 * NaN/Infinity included), 8 missing/extra/wrong shape/type, 9 exactly 513
 * raw bytes.
 */
function buildCase(category: number, variant: number, s: number): BuiltCase {
  switch (category) {
    case 0: {
      const code = s & 255;
      return { input: numericFrame(code), expected: { type: 'GIT_RESULT', code, signal: null } };
    }
    case 1: {
      const name = variant % 3 === 0 ? 'SIGTERM' : variant % 3 === 1 ? 'SIGKILL' : 'SIGUSR2';
      return { input: signalFrame(name), expected: { type: 'GIT_RESULT', code: null, signal: name } };
    }
    case 2: {
      const literals = ['-1', '256', '0.5', '"0"', '9007199254740993', '1e999', 'NaN', 'Infinity'];
      const text = '{"type":"GIT_RESULT","code":' + literals[variant % 8] + ',"signal":null}';
      return { input: bytesOf(text), expected: null };
    }
    case 3: {
      const text =
        variant % 2 === 0
          ? '{"type":"GIT_RESULT","code":0,"signal":"SIGTERM"}'
          : '{"type":"GIT_RESULT","code":null,"signal":null}';
      return { input: bytesOf(text), expected: null };
    }
    case 4: {
      const texts = [
        '{"type":"GIT_RESULT","code":0,"signal":null,"code":1}',
        '{"code":0,"code":1,"type":"GIT_RESULT","signal":null}',
        '{"type":"GIT_RESULT","code":null,"signal":"SIGTERM","signal":"SIGTERM"}',
        '{"type":"GIT_RESULT","type":"GIT_RESULT","code":0,"signal":null}',
      ];
      return { input: bytesOf(texts[variant % 4]), expected: null };
    }
    case 5: {
      // OR2b in the property: subvariants 0-3 return the SAME shared
      // DUP_CODE_PAIR_ROWS rows the static matrix consumes, each carrying
      // its actual row id alongside the selected input; 4/5 keep the valid
      // last-wins signal and (restored) escaped-type duplicates.
      if (variant % 6 <= 3) {
        const row = DUP_CODE_PAIR_ROWS[variant % 6];
        return { input: row.input, expected: null, dupRowId: row.id };
      }
      if (variant % 6 === 4) {
        return {
          input: bytesOf('{"type":"GIT_RESULT","code":null,"signal":"SIGTERM","sig' + esc(0x6e) + 'al":"SIGTERM"}'),
          expected: null,
        };
      }
      // Restored R22 escaped-type duplicate: escaped and literal type keys
      // BOTH carry GIT_RESULT, so last-wins would decode a valid frame and
      // duplicate detection is the only rejection cause.
      return {
        input: bytesOf('{"ty' + esc(0x70) + 'e":"GIT_RESULT","type":"GIT_RESULT","code":0,"signal":null}'),
        expected: null,
      };
    }
    case 6: {
      const head = bytesOf('{"type":"GIT_RE');
      const tail = bytesOf('SULT","code":0,"signal":null}');
      const bads: number[][] = [[0x80], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xc3]];
      return { input: joinBytes([head, bads[variant % 4], tail]), expected: null };
    }
    case 7: {
      const texts = [
        '{"type":"GIT_RESULT","code":0',
        '{"type":"GIT_RESULT","code":0,"signal":null}x',
        '{"type":"GIT_RESULT","code":NaN,"signal":null}',
        "{'type':'GIT_RESULT','code':0,'signal':null}",
      ];
      return { input: bytesOf(texts[variant % 4]), expected: null };
    }
    case 8: {
      const texts = [
        '{"type":"GIT_RESULT","code":0}',
        '{"type":"GIT_RESULT","signal":"SIGTERM"}',
        '{"code":0,"signal":null}',
        '{"type":"GIT_RESULT","code":0,"signal":null,"extra":1}',
        '{"type":"GIT_OTHER","code":0,"signal":null}',
        '{"type":{"nested":true},"code":0,"signal":null}',
      ];
      return { input: bytesOf(texts[variant % 6]), expected: null };
    }
    case 9: {
      const base = '{"type":"GIT_RESULT","code":' + String(s & 255) + ',"signal":null}';
      const kind = variant % 3;
      const padUnit = kind === 0 ? ' ' : kind === 1 ? String.fromCharCode(9) : String.fromCharCode(10);
      return { input: bytesOf(base + padUnit.repeat(513 - base.length)), expected: null };
    }
    default: {
      throw new Error('unreachable S1P1 category ' + String(category));
    }
  }
}

describe('S1 dormant result-frame syntax (ownedGitProtocol)', () => {
  test('S1O01 valid numeric tuples: code 0/1/128/255 with explicit null signal', () => {
    for (const code of [0, 1, 128, 255]) {
      expect(decodeGitResultFrame(numericFrame(code))).toEqual({ type: 'GIT_RESULT', code, signal: null });
    }
  });

  test('S1O02 valid signal tuples: code null with SIGTERM/SIGKILL/SIGUSR2', () => {
    for (const name of ['SIGTERM', 'SIGKILL', 'SIGUSR2']) {
      expect(decodeGitResultFrame(signalFrame(name))).toEqual({ type: 'GIT_RESULT', code: null, signal: name });
    }
  });

  test('S1O03 valid alternate order, escaped keys/values, JSON whitespace, and the NaN-to-null encoding', () => {
    expect(decodeGitResultFrame(bytesOf('{"signal":null,"code":5,"type":"GIT_RESULT"}'))).toEqual({
      type: 'GIT_RESULT',
      code: 5,
      signal: null,
    });
    expect(decodeGitResultFrame(bytesOf('{"ty' + esc(0x70) + 'e":"GIT_RESULT","code":7,"signal":null}'))).toEqual({
      type: 'GIT_RESULT',
      code: 7,
      signal: null,
    });
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_' + esc(0x52) + 'ESULT","code":9,"signal":null}'))).toEqual({
      type: 'GIT_RESULT',
      code: 9,
      signal: null,
    });
    expect(decodeGitResultFrame(bytesOf('{ "type" : "GIT_RESULT" , "code" : 11 , "signal" : null }'))).toEqual({
      type: 'GIT_RESULT',
      code: 11,
      signal: null,
    });
    // OR1a: accepted LF (0A) and CR (0D) JSON whitespace. Leading position:
    expect(
      decodeGitResultFrame(bytesOf(String.fromCharCode(10) + '{"type":"GIT_RESULT","code":12,"signal":null}')),
    ).toEqual({ type: 'GIT_RESULT', code: 12, signal: null });
    expect(
      decodeGitResultFrame(bytesOf(String.fromCharCode(13) + '{"type":"GIT_RESULT","code":12,"signal":null}')),
    ).toEqual({ type: 'GIT_RESULT', code: 12, signal: null });
    // Inter-member positions:
    expect(
      decodeGitResultFrame(
        bytesOf(
          '{"type":"GIT_RESULT",' +
            String.fromCharCode(10) +
            '"code":12,' +
            String.fromCharCode(13) +
            String.fromCharCode(10) +
            '"signal":null}',
        ),
      ),
    ).toEqual({ type: 'GIT_RESULT', code: 12, signal: null });
    // Trailing position (both terminators):
    expect(
      decodeGitResultFrame(
        bytesOf('{"type":"GIT_RESULT","code":12,"signal":null}' + String.fromCharCode(10) + String.fromCharCode(13)),
      ),
    ).toEqual({ type: 'GIT_RESULT', code: 12, signal: null });
    // JSON.stringify({type:'GIT_RESULT', code:NaN, signal:'SIGTERM'}) encodes
    // code:null: a VALID signal tuple after encoding.
    expect(JSON.stringify({ type: 'GIT_RESULT', code: NaN, signal: 'SIGTERM' })).toBe(
      '{"type":"GIT_RESULT","code":null,"signal":"SIGTERM"}',
    );
    expect(decodeGitResultFrame(signalFrame('SIGTERM'))).toEqual({ type: 'GIT_RESULT', code: null, signal: 'SIGTERM' });
  });

  test('S1O04 invalid tuples, keys and shapes return null', () => {
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":0,"signal":"SIGTERM"}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":null,"signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":0}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","signal":"SIGTERM"}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"code":0,"signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":0,"signal":null,"extra":1}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"typ":"GIT_RESULT","code":0,"signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_OTHER","code":0,"signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":1,"code":0,"signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":"0","signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":0,"signal":7}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('[1,2]'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('null'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('42'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":{"nested":true},"code":0,"signal":null}'))).toBeNull();
  });

  test('S1O05 invalid code values return null', () => {
    expect(decodeGitResultFrame(numericFrame(-1))).toBeNull();
    expect(decodeGitResultFrame(numericFrame(256))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":0.5,"signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":"0","signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":9007199254740993,"signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":NaN,"signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":Infinity,"signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":1e999,"signal":null}'))).toBeNull();
  });

  test('S1O06 invalid signal strings return null, including final line terminators', () => {
    expect(decodeGitResultFrame(signalFrame(''))).toBeNull();
    expect(decodeGitResultFrame(signalFrame('sigterm'))).toBeNull();
    expect(decodeGitResultFrame(signalFrame('TERM'))).toBeNull();
    expect(decodeGitResultFrame(signalFrame('SIG'))).toBeNull();
    expect(decodeGitResultFrame(signalFrame('SIG TERM'))).toBeNull();
    expect(decodeGitResultFrame(signalFrame('SIGTERM' + String.fromCharCode(10)))).toBeNull();
    expect(decodeGitResultFrame(signalFrame('SIGTERM' + String.fromCharCode(13)))).toBeNull();
    // OR2a: VALID JSON whose decoded signal carries LF or CR (backslash
    // escapes in the JSON source, one control unit after decoding) still
    // returns null. The two raw cases above are malformed JSON; these are
    // not, so the rejection exercises the signal language itself.
    expect(decodeGitResultFrame(signalFrame('SIGTERM' + BACKSLASH + 'n'))).toBeNull();
    expect(decodeGitResultFrame(signalFrame('SIGTERM' + BACKSLASH + 'r'))).toBeNull();
    expect(decodeGitResultFrame(signalFrame('SIGTERM' + String.fromCharCode(0x2028)))).toBeNull();
    expect(decodeGitResultFrame(signalFrame('SIGTERM' + String.fromCharCode(0x2029)))).toBeNull();
  });

  test('S1O07 literal and escaped-equal duplicate keys return null in either order', () => {
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":0,"signal":null,"code":1}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"code":0,"code":1,"type":"GIT_RESULT","signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":0,"code":0,"signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":null,"signal":"SIGTERM","signal":"SIGTERM"}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","type":"GIT_RESULT","code":0,"signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","' + esc(0x63) + 'ode":0,"code":1,"signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"' + esc(0x63) + 'ode":1,"code":0,"type":"GIT_RESULT","signal":null}'))).toBeNull();
    expect(
      decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":null,"signal":"SIGTERM","sig' + esc(0x6e) + 'al":"SIGKILL"}')),
    ).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"ty' + esc(0x70) + 'e":"GIT_RESULT","type":"GIT_OTHER","code":0,"signal":null}'))).toBeNull();
    // OR2b: the static matrix IS the shared DUP_CODE_PAIR_ROWS table (the
    // property consumes the same rows). Every row is otherwise valid under
    // JSON last-wins (type GIT_RESULT, signal null, codes 0..255), so a
    // last-wins decoder would still return a valid numeric tuple; the null
    // must come from duplicate-key detection, not from a malformed frame.
    expect(DUP_CODE_PAIR_ROWS.length).toBe(4);
    expect(new Set(DUP_CODE_PAIR_ROWS.map((row) => row.id)).size).toBe(4);
    for (let a = 0; a < DUP_CODE_PAIR_ROWS.length; a += 1) {
      for (let b = a + 1; b < DUP_CODE_PAIR_ROWS.length; b += 1) {
        expect(DUP_CODE_PAIR_ROWS[a].id).not.toBe(DUP_CODE_PAIR_ROWS[b].id);
        expect(DUP_CODE_PAIR_ROWS[a].input).not.toEqual(DUP_CODE_PAIR_ROWS[b].input);
      }
      expect(decodeGitResultFrame(DUP_CODE_PAIR_ROWS[a].input)).toBeNull();
    }
  });

  test('S1O08 malformed or truncated UTF-8, leading BOM, and non-JSON whitespace return null', () => {
    const good = 'SULT","code":0,"signal":null}';
    expect(decodeGitResultFrame(joinBytes([bytesOf('{"type":"GIT_RE'), [0xff], bytesOf(good)]))).toBeNull();
    expect(decodeGitResultFrame(joinBytes([bytesOf('{"type":"GIT_RE'), [0xc0, 0x80], bytesOf(good)]))).toBeNull();
    expect(decodeGitResultFrame(joinBytes([bytesOf('{"type":"GIT_RE'), [0xed, 0xa0, 0x80], bytesOf(good)]))).toBeNull();
    expect(decodeGitResultFrame(joinBytes([bytesOf('{"type":"GIT_RE'), [0x80], bytesOf(good)]))).toBeNull();
    expect(decodeGitResultFrame(joinBytes([bytesOf('{"type":"GIT_RE'), [0xc3], bytesOf(good)]))).toBeNull();
    // OR1b: a complete VALID frame followed by a lone incomplete UTF-8
    // sequence at TRUE end-of-input (a C3 lead byte with no continuation,
    // then an E2 82 three-byte lead missing its final unit). The decoder
    // must return null without throwing; the frame itself proves the
    // rejection comes from the trailing bytes, not the JSON.
    expect(
      decodeGitResultFrame(joinBytes([bytesOf('{"type":"GIT_RESULT","code":0,"signal":null}'), [0xc3]])),
    ).toBeNull();
    expect(
      decodeGitResultFrame(joinBytes([bytesOf('{"type":"GIT_RESULT","code":0,"signal":null}'), [0xe2, 0x82]])),
    ).toBeNull();
    expect(decodeGitResultFrame(bytesOf(String.fromCharCode(0xfeff) + '{"type":"GIT_RESULT","code":0,"signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf(String.fromCharCode(0xa0) + '{"type":"GIT_RESULT","code":0,"signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":0,"signal":null}' + String.fromCharCode(12)))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":0,"signal":null}' + String.fromCharCode(11)))).toBeNull();
  });

  test('S1O09 empty, whitespace-only, malformed, trailing, concatenated, and wrong-shape string inputs return null without throwing', () => {
    expect(decodeGitResultFrame(new Uint8Array(0))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('   '))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":0,"signal":null}x'))).toBeNull();
    expect(
      decodeGitResultFrame(
        bytesOf('{"type":"GIT_RESULT","code":0,"signal":null}{"type":"GIT_RESULT","code":1,"signal":null}'),
      ),
    ).toBeNull();
    const inner = '{' + BACKSLASH + '"GIT_RESULT' + BACKSLASH + '":1}';
    expect(decodeGitResultFrame(bytesOf('{"type":"' + inner + '","code":0,"signal":null}'))).toBeNull();
    expect(decodeGitResultFrame(bytesOf('{"type":"GIT_RESULT","code":"' + BACKSLASH + BACKSLASH + '0","signal":null}'))).toBeNull();
  });

  test('S1O10 whitespace padding: exactly 512 raw bytes accepted, 513 rejected', () => {
    const base = '{"type":"GIT_RESULT","code":21,"signal":null}';
    const pad512 = base + ' '.repeat(512 - base.length);
    const pad513 = base + ' '.repeat(513 - base.length);
    expect(pad512.length).toBe(512);
    expect(pad513.length).toBe(513);
    expect(decodeGitResultFrame(bytesOf(pad512))).toEqual({ type: 'GIT_RESULT', code: 21, signal: null });
    expect(decodeGitResultFrame(bytesOf(pad513))).toBeNull();
    const tab512 = base + ' '.repeat(512 - base.length - 1) + String.fromCharCode(9);
    expect(tab512.length).toBe(512);
    expect(decodeGitResultFrame(bytesOf(tab512))).toEqual({ type: 'GIT_RESULT', code: 21, signal: null });
    // OR1a: exactly-512 padding may END in LF or CR and stays accepted; the
    // byte length is asserted on the encoded bytes, not just the string.
    const lf512 = base + ' '.repeat(512 - base.length - 1) + String.fromCharCode(10);
    expect(bytesOf(lf512).byteLength).toBe(512);
    expect(decodeGitResultFrame(bytesOf(lf512))).toEqual({ type: 'GIT_RESULT', code: 21, signal: null });
    const cr512 = base + ' '.repeat(512 - base.length - 1) + String.fromCharCode(13);
    expect(bytesOf(cr512).byteLength).toBe(512);
    expect(decodeGitResultFrame(bytesOf(cr512))).toEqual({ type: 'GIT_RESULT', code: 21, signal: null });
    const lf513 = base + ' '.repeat(513 - base.length - 1) + String.fromCharCode(10);
    expect(lf513.length).toBe(513);
    expect(decodeGitResultFrame(bytesOf(lf513))).toBeNull();
  });

  test('S1O11 valid frame inside a Uint8Array subview ignores unrelated backing bytes', () => {
    const frame = bytesOf('{"type":"GIT_RESULT","code":34,"signal":null}');
    const backed = joinBytes([[0xff, 0xfe, 0xef], frame, [0xff, 0x00, 0xc0]]);
    const view = backed.subarray(3, 3 + frame.length);
    expect(view.byteLength).toBe(frame.byteLength);
    expect(decodeGitResultFrame(view)).toEqual({ type: 'GIT_RESULT', code: 34, signal: null });
  });

  // S1O12 (documented, NOT executed here): deleting the numeric branch's
  // explicit signal===null guard must make BOTHSET
  // {"type":"GIT_RESULT","code":0,"signal":"SIGTERM"} wrongly accepted, so
  // the FIRST expected failing assertion is the BOTHSET rejection in S1O04
  // above; a missing-signal mutant stays masked by the exact-key guard. The
  // guard-removal run itself is a later, separately authorized change.

  test('S1P1 exact-500 seeded generator: constructed post-encoding expectations against the actual decoder', () => {
    let s = 0x6009 >>> 0;
    const counts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let case5Calls = 0;
    const dupRowHits: Record<string, number> = {};
    let numericCases = 0;
    let signalCases = 0;
    for (let i = 0; i < 500; i += 1) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const category = i % 10;
      const variant = Math.floor(i / 10);
      counts[category] += 1;
      const built = buildCase(category, variant, s);
      if (built.expected !== null && built.expected.code !== null) numericCases += 1;
      if (built.expected !== null && built.expected.code === null) signalCases += 1;
      expect(() => decodeGitResultFrame(built.input)).not.toThrow();
      const first = decodeGitResultFrame(built.input);
      const second = decodeGitResultFrame(built.input);
      expect(second).toEqual(first);
      if (built.expected === null) {
        expect(first).toBeNull();
      } else {
        expect(first).toEqual(built.expected);
      }
      // Hit accounting AFTER buildCase and the null/expected assertion of
      // the returned input, keyed by the returned shared-row id so every
      // counted hit had that row's actual constructed bytes.
      if (category === 5) {
        case5Calls += 1;
        if (built.dupRowId !== undefined) {
          const row = DUP_CODE_PAIR_ROWS.find((entry) => entry.id === built.dupRowId);
          if (row === undefined) throw new Error('unknown shared dup row ' + String(built.dupRowId));
          expect(built.input).toBe(row.input);
          dupRowHits[built.dupRowId] = (dupRowHits[built.dupRowId] ?? 0) + 1;
        }
      }
    }
    for (const count of counts) expect(count).toBe(50);
    // OR2b presence, tied to actual shared constructed rows: variants 0-49
    // modulo 6 give 9/9/8/8/8/8, so each of the four shared code rows is
    // exercised at least 8 times and the remaining 16 calls are the
    // signal/type duplicates.
    expect(case5Calls).toBe(50);
    let codeRowHits = 0;
    for (const row of DUP_CODE_PAIR_ROWS) {
      const hits = dupRowHits[row.id] ?? 0;
      expect(hits).toBeGreaterThanOrEqual(8);
      codeRowHits += hits;
    }
    expect(codeRowHits).toBe(34);
    expect(numericCases).toBe(50);
    expect(signalCases).toBe(50);
  });
});

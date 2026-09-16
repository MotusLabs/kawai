import { describe, expect, it } from 'bun:test'
import { isBenignProxyError, shouldSuppressProxyLog } from '../devProxyErrors'

describe('isBenignProxyError', () => {
  it('matches known transient socket codes', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ERR_STREAM_WRITE_AFTER_END']) {
      expect(isBenignProxyError({ code })).toBe(true)
    }
  })

  it('matches codes surfaced only in the message', () => {
    expect(isBenignProxyError(new Error('write EPIPE'))).toBe(true)
  })

  it('unwraps AggregateError from dual-stack localhost failures', () => {
    expect(isBenignProxyError({ errors: [{ code: 'ENOTFOUND' }, { code: 'ECONNREFUSED' }] })).toBe(
      true
    )
  })

  it('rejects unrelated errors and non-objects', () => {
    expect(isBenignProxyError({ code: 'EACCES' })).toBe(false)
    expect(isBenignProxyError(new Error('socket hang up'))).toBe(false)
    expect(isBenignProxyError({ errors: [{ code: 'EACCES' }] })).toBe(false)
    expect(isBenignProxyError({ code: 42 })).toBe(false)
    expect(isBenignProxyError(null)).toBe(false)
    expect(isBenignProxyError('EPIPE')).toBe(false)
  })
})

describe('shouldSuppressProxyLog', () => {
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })

  it('suppresses benign http, ws, and ws socket proxy errors', () => {
    expect(shouldSuppressProxyLog('http proxy error: /api/sessions', epipe)).toBe(true)
    expect(shouldSuppressProxyLog('ws proxy error:', epipe)).toBe(true)
    expect(shouldSuppressProxyLog('ws proxy socket error:', epipe)).toBe(true)
  })

  it('falls back to the message when no error object is attached', () => {
    expect(shouldSuppressProxyLog('ws proxy error:\nError: write EPIPE')).toBe(true)
    expect(shouldSuppressProxyLog('ws proxy error:\nError: socket hang up')).toBe(false)
  })

  it('keeps proxy errors that are not transient', () => {
    expect(shouldSuppressProxyLog('ws proxy error:', new Error('socket hang up'))).toBe(false)
  })

  it('keeps non-proxy log lines even when the error is benign', () => {
    expect(shouldSuppressProxyLog('ws proxy bypass error:', epipe)).toBe(false)
    expect(shouldSuppressProxyLog('Internal server error', epipe)).toBe(false)
  })
})

// activityBucket.ts - shared 30s-bucket comparison for session activity
// timestamps. Server broadcast change detection (design D5) and client row
// memoization (design D6) both quantize to this bucket, while stored and
// displayed timestamps keep full precision.

/** Activity quantization window for change detection (ms). */
export const ACTIVITY_BUCKET_MS = 30_000

/**
 * True when two lastActivity timestamps fall in the same 30s bucket.
 * Invalid (unparseable) timestamps fall back to raw string equality,
 * preserving the pre-quantization behavior for malformed values.
 */
export function activityInSameBucket(a: string, b: string): boolean {
  const timeA = Date.parse(a)
  const timeB = Date.parse(b)
  if (Number.isNaN(timeA) || Number.isNaN(timeB)) {
    return a === b
  }
  return (
    Math.floor(timeA / ACTIVITY_BUCKET_MS) === Math.floor(timeB / ACTIVITY_BUCKET_MS)
  )
}

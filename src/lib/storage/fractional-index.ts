/**
 * Lexicographical fractional indexing based on base-62 alphabet ('0'-'9', 'A'-'Z', 'a'-'z').
 *
 * Keys sort identically under byte-wise comparison / standard string comparison.
 * Between any two keys a strictly intermediate key can always be constructed.
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const BASE = DIGITS.length // 62
const FIRST_CHAR = DIGITS[0] // '0'
const MID_CHAR = DIGITS[Math.floor(BASE / 2)] // 'V' (index 31)

function charToVal(c: string): number {
  const code = c.charCodeAt(0)
  // '0'-'9': 48-57 -> 0-9
  if (code >= 48 && code <= 57) return code - 48
  // 'A'-'Z': 65-90 -> 10-35
  if (code >= 65 && code <= 90) return code - 65 + 10
  // 'a'-'z': 97-122 -> 36-61
  if (code >= 97 && code <= 122) return code - 97 + 36
  return -1
}

function valToChar(v: number): string {
  return DIGITS[v]
}

/**
 * Generates an initial order key when no keys exist.
 */
export function getInitialOrderKey(): string {
  return "a0"
}

/**
 * Generates a fractional index string strictly between `before` and `after`.
 *
 * - If `before === null` and `after === null`: returns "a0"
 * - If `before === null` and `after !== null`: returns a key strictly smaller than `after`
 * - If `before !== null` and `after === null`: returns a key strictly greater than `before`
 * - If both are given: returns a key where `before < key < after`
 *
 * Note: if before >= after, this indicates an anomaly; a tie-breaking extension is appended.
 */
export function generateFractionalIndex(before: string | null, after: string | null): string {
  if (!before && !after) {
    return getInitialOrderKey()
  }

  if (!before && after) {
    // Generate key smaller than after
    for (let i = 0; i < after.length; i++) {
      const val = charToVal(after[i])
      if (val > 0) {
        const midVal = Math.floor(val / 2)
        if (midVal > 0) {
          return after.slice(0, i) + valToChar(midVal)
        }
        // If val === 1 and midVal === 0, we can use '0' followed by midpoint
        return after.slice(0, i) + FIRST_CHAR + MID_CHAR
      }
    }
    // after starts with all '0's
    return FIRST_CHAR + after
  }

  if (before && !after) {
    // Generate key greater than before
    for (let i = 0; i < before.length; i++) {
      const val = charToVal(before[i])
      if (val < BASE - 1) {
        const midVal = Math.ceil((val + BASE) / 2)
        if (midVal < BASE) {
          return before.slice(0, i) + valToChar(midVal)
        }
      }
    }
    // before is all 'z's or we append a mid char
    return before + MID_CHAR
  }

  // Both before and after exist
  const b = before!
  const a = after!

  if (b >= a) {
    // Anomaly: before >= after. Append a tie-breaker.
    return b + MID_CHAR
  }

  // Find first index where b and a diverge
  let i = 0
  while (i < b.length && i < a.length && b[i] === a[i]) {
    i++
  }

  const bVal = i < b.length ? charToVal(b[i]) : 0
  const aVal = i < a.length ? charToVal(a[i]) : BASE

  if (aVal - bVal > 1) {
    // There is room between bVal and aVal
    const midVal = Math.floor((bVal + aVal) / 2)
    return b.slice(0, i) + valToChar(midVal)
  }

  // aVal - bVal === 1 (consecutive characters, e.g. 'a' and 'b')
  // We keep prefix including b[i], and insert between the rest of b and end
  if (i < b.length) {
    // Check remaining characters in b
    return b + MID_CHAR
  }

  // i === b.length: b is a prefix of a, e.g. b = "a", a = "a0"
  // If b is a prefix of a, b < a already, but we need something between b and a.
  // We can take a's prefix up to where it's > 0, or append to b.
  return b + FIRST_CHAR + MID_CHAR
}

/**
 * Compare two order keys lexicographically.
 * Returns -1 if a < b, 1 if a > b, 0 if equal.
 */
export function compareOrderKeys(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

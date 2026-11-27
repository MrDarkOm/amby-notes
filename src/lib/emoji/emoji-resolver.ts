import manifest from "./manifest.json"

export const NOTO_RELEASE = manifest.release

const sequences: Readonly<Record<string, string | null>> = manifest.sequences
const maxLength = Math.max(...Object.keys(sequences).map((value) => value.length))
const hasSequence = (value: string) => Object.prototype.hasOwnProperty.call(sequences, value)
const continuation = /^(?:[\uFE0E\uFE0F]|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}])/u

/** Only the lookup is canonicalized by the generated manifest; input is never rewritten. */
export function resolveEmoji(value: string): string | null {
  const file = hasSequence(value) ? sequences[value] : null
  return file
    ? `${import.meta.env.BASE_URL}emoji/noto/${file}?v=${NOTO_RELEASE}-${manifest.assetVersion}`
    : null
}

/** A leading icon, with UTF-16 offsets matching Markdown/ProseMirror. No Intl dependency. */
export function leadingEmoji(text: string): string | undefined {
  let end = 0
  let found = 0
  for (const point of text.slice(0, maxLength)) {
    end += point.length
    if (hasSequence(text.slice(0, end))) found = end
  }
  if (!found) return undefined

  // Never mistake the supported beginning of a newer/unknown cluster for its whole icon.
  // Keep presentation selectors, modifiers, tag flags and ZWJ tails in the original value.
  while (found < text.length) {
    const suffix = text.slice(found)
    const next = continuation.exec(suffix)?.[0]
    if (next) found += next.length
    else if (suffix.startsWith("\u200D")) {
      const point = suffix.codePointAt(1)
      found += 1 + (point === undefined ? 0 : String.fromCodePoint(point).length)
    } else break
  }
  return text.slice(0, found)
}

/** Emoji Mart passes hex sequences, not native strings, to its image callback. */
export function pickerEmojiUrl(_set: string, unified: string): string {
  const points = unified.split("-")
  if (
    !points.every((point) => {
      const code = parseInt(point, 16)
      return (
        /^[a-f\d]{1,6}$/iu.test(point) && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      )
    })
  ) {
    return nativeEmojiImage("")
  }
  const value = String.fromCodePoint(...points.map((point) => parseInt(point, 16)))
  return resolveEmoji(value) ?? nativeEmojiImage(value)
}

/** Local text fallback for a picker entry outside the pinned artwork's coverage. */
function nativeEmojiImage(value: string): string {
  const escaped = value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><text x="36" y="54" font-size="60" text-anchor="middle">${escaped}</text></svg>`)}`
}

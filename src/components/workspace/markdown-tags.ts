export interface ObsidianTagMatch {
  /** Original spelling without the leading hash. */
  display: string
  /** Case-insensitive lookup key. */
  normalized: string
  from: number
  to: number
}

export interface MarkdownRange {
  from: number
  to: number
}

const TAG_CHARACTER_RE = /[\p{L}\p{N}_/-]/u
const TAG_NON_NUMERIC_RE = /[\p{L}_-]/u
const TAG_BOUNDARY_RE = /[\p{L}\p{N}_/#]/u

function rangeContains(ranges: MarkdownRange[], position: number): boolean {
  return ranges.some((range) => position >= range.from && position < range.to)
}

/**
 * Ranges where Obsidian does not interpret inline tags: YAML, code and comments.
 * This intentionally stays a conservative scanner: an unterminated construct is
 * protected through EOF rather than producing false tags.
 */
export function protectedMarkdownRanges(source: string): MarkdownRange[] {
  const ranges: MarkdownRange[] = []

  if (source.startsWith("---\n") || source.startsWith("---\r\n")) {
    const newlineLength = source.startsWith("---\r\n") ? 2 : 1
    let cursor = 3 + newlineLength
    while (cursor < source.length) {
      const lineEnd = source.indexOf("\n", cursor)
      const end = lineEnd < 0 ? source.length : lineEnd + 1
      const line = source.slice(cursor, lineEnd < 0 ? source.length : lineEnd).replace(/\r$/u, "")
      if (line === "---" || line === "...") {
        ranges.push({ from: 0, to: end })
        break
      }
      cursor = end
    }
  }

  let index = 0
  while (index < source.length) {
    if (source.startsWith("%%", index)) {
      const close = source.indexOf("%%", index + 2)
      const to = close < 0 ? source.length : close + 2
      ranges.push({ from: index, to })
      index = to
      continue
    }

    const atLineStart = index === 0 || source[index - 1] === "\n"
    if (atLineStart) {
      const lineEnd = source.indexOf("\n", index)
      const lineTo = lineEnd < 0 ? source.length : lineEnd
      const line = source.slice(index, lineTo)
      const fence = /^\s*(`{3,}|~{3,})/u.exec(line)
      if (fence) {
        const marker = fence[1][0]
        const minimum = fence[1].length
        let closeFrom = lineEnd < 0 ? source.length : lineEnd + 1
        let closeTo = source.length
        while (closeFrom < source.length) {
          const nextEnd = source.indexOf("\n", closeFrom)
          const nextTo = nextEnd < 0 ? source.length : nextEnd
          const nextLine = source.slice(closeFrom, nextTo)
          const closeFence = new RegExp(`^\\s*${marker}{${minimum},}\\s*$`, "u")
          if (closeFence.test(nextLine)) {
            closeTo = nextEnd < 0 ? source.length : nextEnd + 1
            break
          }
          closeFrom = nextEnd < 0 ? source.length : nextEnd + 1
        }
        ranges.push({ from: index, to: closeTo })
        index = closeTo
        continue
      }
    }

    if (source[index] === "`") {
      let delimiterEnd = index
      while (source[delimiterEnd] === "`") delimiterEnd++
      const delimiter = source.slice(index, delimiterEnd)
      const lineEnd = source.indexOf("\n", delimiterEnd)
      const searchTo = lineEnd < 0 ? source.length : lineEnd
      const close = source.indexOf(delimiter, delimiterEnd)
      if (close >= 0 && close < searchTo) {
        const to = close + delimiter.length
        ranges.push({ from: index, to })
        index = to
        continue
      }
    }

    index++
  }

  return ranges.sort((left, right) => left.from - right.from)
}

export function isValidObsidianTag(value: string): boolean {
  if (!value || !TAG_NON_NUMERIC_RE.test(value)) return false
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//")) return false
  return [...value].every((character) => TAG_CHARACTER_RE.test(character))
}

/** Extract inline tags using Obsidian's documented grammar. */
export function extractObsidianTags(source: string): ObsidianTagMatch[] {
  const protectedRanges = protectedMarkdownRanges(source)
  const matches: ObsidianTagMatch[] = []

  for (let index = 0; index < source.length; index++) {
    if (source[index] !== "#" || rangeContains(protectedRanges, index)) continue
    if (index > 0 && source[index - 1] === "\\") continue
    if (index > 0 && TAG_BOUNDARY_RE.test(source[index - 1])) continue

    let end = index + 1
    while (end < source.length && TAG_CHARACTER_RE.test(source[end])) end++
    const display = source.slice(index + 1, end)
    if (!isValidObsidianTag(display)) continue
    matches.push({
      display,
      normalized: display.normalize("NFC").toLocaleLowerCase(),
      from: index,
      to: end,
    })
    index = end - 1
  }

  return matches
}

export function tagIncludes(parent: string, candidate: string): boolean {
  const normalizedParent = parent.normalize("NFC").toLocaleLowerCase()
  const normalizedCandidate = candidate.normalize("NFC").toLocaleLowerCase()
  return (
    normalizedCandidate === normalizedParent ||
    normalizedCandidate.startsWith(`${normalizedParent}/`)
  )
}

interface FoldedCharacter {
  character: string
  start: number
  end: number
}

function foldedCharacters(text: string): FoldedCharacter[] {
  const characters: FoldedCharacter[] = []
  let offset = 0
  for (const source of text) {
    const end = offset + source.length
    for (const character of source.toLowerCase()) characters.push({ character, start: offset, end })
    offset = end
  }
  return characters
}

/** Returns source-string UTF-16 boundaries without indexing into a lowercased copy. */
export function caseInsensitiveRange(text: string, query: string): [number, number] | null {
  const needle = foldedCharacters(query)
  if (needle.length === 0) return null
  const haystack = foldedCharacters(text)
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (
      needle.every((character, index) => character.character === haystack[start + index].character)
    ) {
      return [haystack[start].start, haystack[start + needle.length - 1].end]
    }
  }
  return null
}

import type { SearchResult } from "@/lib/storage"

/**
 * Where a world page is named in the text of the stories. Everything here is read-only: the
 * names come from the page's title and the `aliases` of its frontmatter (the key other Markdown
 * apps use too), the places from the vault's search index. Nothing is stored or linked.
 */

export interface TextPageInfo {
  title: string
  storyName: string
}

export interface TextMention {
  noteId: string
  title: string
  storyName: string
  /** The words around the name, as the search index gives them. */
  snippet: string
}

/** Shorter words of a title ("de", "Jo") would be found everywhere. */
const MIN_WORD_LENGTH = 3
/** A name with a case ending still names the same person: "Кей" in "Кея", "Evan" in "evan's". */
const MAX_ENDING = 3
const SOFT_ENDINGS = /[аяйьоеыиую]$/iu
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)

function words(text: string): string[] {
  return text.split(/[^\p{L}\p{N}_]+/u).filter(Boolean)
}

function unquote(value: string): string {
  const trimmed = value.trim()
  const quoted = /^(["'])(.*)\1$/u.exec(trimmed)
  return (quoted ? quoted[2] : trimmed).trim()
}

/** The `aliases` (or `alias`) of the frontmatter: a block list, a flow list or one value. */
function frontmatterAliases(markdown: string): string[] {
  const text = markdown.startsWith(BYTE_ORDER_MARK) ? markdown.slice(1) : markdown
  const lines = text.split(/\r?\n/u)
  if (lines[0]?.trim() !== "---") return []
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/u.test(line))
  if (end < 0) return []
  const aliases: string[] = []
  for (let index = 1; index < end; index += 1) {
    const match = /^(aliases|alias)\s*:\s*(.*)$/u.exec(lines[index])
    if (!match) continue
    const value = match[2].trim()
    if (value.startsWith("[")) {
      const inner = value.replace(/^\[|\]$/gu, "")
      aliases.push(...inner.split(",").map(unquote))
    } else if (value) {
      aliases.push(unquote(value))
    } else {
      for (let item = index + 1; item < end; item += 1) {
        const entry = /^\s*-\s+(.*)$/u.exec(lines[item])
        if (!entry) break
        aliases.push(unquote(entry[1]))
      }
    }
  }
  return aliases.filter(Boolean)
}

/**
 * The names to look for, in order and once each (ignoring case): the whole title, every word of a
 * title of several words that is long enough to tell apart, then the aliases.
 */
export function mentionNames(title: string, markdown: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  const add = (name: string) => {
    const clean = name.trim().replace(/\s+/gu, " ")
    const key = clean.toLocaleLowerCase()
    if (!clean || seen.has(key)) return
    seen.add(key)
    names.push(clean)
  }
  add(title)
  const titleWords = words(title)
  if (titleWords.length > 1) {
    for (const word of titleWords) if (word.length >= MIN_WORD_LENGTH) add(word)
  }
  for (const alias of frontmatterAliases(markdown)) add(alias)
  return names
}

/**
 * What to ask the search index for. It matches by word prefix, so a declined form is found by its
 * stem ("Алис" for "Алисы"); a stem shorter than a word worth searching is not asked.
 */
export function searchQueries(names: readonly string[]): { name: string; query: string }[] {
  const queries: { name: string; query: string }[] = []
  for (const name of names) {
    queries.push({ name, query: name })
    const parts = name.split(" ")
    const last = parts[parts.length - 1]
    if (SOFT_ENDINGS.test(last) && last.length - 1 >= MIN_WORD_LENGTH) {
      queries.push({ name, query: [...parts.slice(0, -1), last.slice(0, -1)].join(" ") })
    }
  }
  return queries
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

/**
 * Whether the text names `name` as a word of its own: any case, any spacing between its words, a
 * short ending allowed. A longer word that only starts the same ("Кейтлин" for "Кей") is not it.
 */
export function mentionsName(text: string, name: string): boolean {
  const parts = name.trim().split(/\s+/u).filter(Boolean)
  if (parts.length === 0) return false
  const body = parts.map(escapePattern).join("\\s+")
  const ending = `(?:\\p{L}{0,${MAX_ENDING}}|['’]\\p{L}{0,2})`
  const alternatives = [`${body}${ending}`]
  // Russian declension replaces a final vowel, "й" or "ь": "Кей" → "Кея", "Алиса" → "Алисы".
  const last = parts[parts.length - 1]
  if (last.length >= MIN_WORD_LENGTH && SOFT_ENDINGS.test(last)) {
    const stem = [...parts.slice(0, -1), last.slice(0, -1)].map(escapePattern).join("\\s+")
    alternatives.push(`${stem}\\p{L}{1,${MAX_ENDING}}`)
  }
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`,
    "iu",
  )
  return pattern.test(text)
}

/**
 * The pages of the text that name the page, each once, in the order the searches found them.
 * A result outside the text, a page already linked, and a hit the search index made only by a
 * prefix ("Кейтлин" for "Кей") are left out.
 */
export function collectMentions({
  searches,
  textPages,
  exclude,
}: {
  searches: { name: string; results: SearchResult[] }[]
  textPages: ReadonlyMap<string, TextPageInfo>
  exclude: ReadonlySet<string>
}): TextMention[] {
  const found = new Map<string, TextMention>()
  for (const { name, results } of searches) {
    for (const { note, snippet } of results) {
      const page = textPages.get(note.id)
      if (!page || exclude.has(note.id) || found.has(note.id) || !snippet) continue
      if (!mentionsName(snippet, name)) continue
      found.set(note.id, { noteId: note.id, title: page.title, storyName: page.storyName, snippet })
    }
  }
  return [...found.values()]
}

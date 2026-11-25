import type { SearchResult } from "@/lib/storage"

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

export function mentionNames(_title: string, _markdown: string): string[] {
  throw new Error("not implemented")
}

export function mentionsName(_text: string, _name: string): boolean {
  throw new Error("not implemented")
}

export function collectMentions(_input: {
  searches: { name: string; results: SearchResult[] }[]
  textPages: ReadonlyMap<string, TextPageInfo>
  exclude: ReadonlySet<string>
}): TextMention[] {
  throw new Error("not implemented")
}

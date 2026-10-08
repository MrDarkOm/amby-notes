import * as React from "react"

import { isTauri, listTags, readFile } from "@/lib/storage"
import { extractObsidianTags } from "../markdown-tags"
import type { TreeItem } from "../sidebar-tree"
import { setSuggestionSources, type NoteSuggestionSource } from "../tiptap/link-suggestions"

const TAGS_FRESH_MS = 10_000

function collectNotes(items: TreeItem[], vault: string | null): NoteSuggestionSource[] {
  const root = vault?.replace(/\\/gu, "/") ?? ""
  const notes: NoteSuggestionSource[] = []
  const walk = (list: TreeItem[]) => {
    for (const item of list) {
      if (item.type === "file") {
        const path = (item.path ?? item.id).replace(/\\/gu, "/")
        // Only notes are link targets the editor can offer by name.
        if (/\.md$/iu.test(path)) {
          const inVault = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
          notes.push({
            name: item.name.replace(/\.md$/iu, ""),
            path: inVault.replace(/\.md$/iu, ""),
          })
        }
      }
      if (item.children) walk(item.children)
    }
  }
  walk(items)
  return notes
}

/** The browser build has no tag index: the tags are read from the notes themselves. */
async function tagsFromNotes(items: TreeItem[]): Promise<string[]> {
  const tags = new Set<string>()
  const files: TreeItem[] = []
  const walk = (list: TreeItem[]) => {
    for (const item of list) {
      if (item.type === "file") files.push(item)
      if (item.children) walk(item.children)
    }
  }
  walk(items)
  await Promise.allSettled(
    files.map(async (file) => {
      for (const match of extractObsidianTags(await readFile(file.id))) tags.add(match.display)
    }),
  )
  return [...tags]
}

/**
 * Gives the editors of this window what they offer while `[[` or `#` is typed: the
 * notes of the tree and the tags of the vault. The tag list is asked for when a
 * suggestion opens and reused for a few seconds of typing.
 */
export function useLinkSuggestionSources(vault: string | null, treeItems: TreeItem[]) {
  const itemsRef = React.useRef(treeItems)
  React.useEffect(() => {
    itemsRef.current = treeItems
  }, [treeItems])

  React.useEffect(() => {
    let cached: { at: number; tags: Promise<string[]> } | null = null
    return setSuggestionSources({
      notes: () => collectNotes(itemsRef.current, vault),
      tags: () => {
        if (cached && Date.now() - cached.at < TAGS_FRESH_MS) return cached.tags
        const tags =
          vault && isTauri()
            ? listTags(vault).then((entries) => entries.map((entry) => entry.tag))
            : tagsFromNotes(itemsRef.current)
        cached = { at: Date.now(), tags }
        // A failed request is not kept: the next suggestion asks again.
        tags.catch(() => {
          if (cached?.tags === tags) cached = null
        })
        return tags
      },
    })
  }, [vault])
}

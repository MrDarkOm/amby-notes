import * as React from "react"
import i18n from "@/lib/i18n"
import { createNote, readNote } from "@/lib/storage"
import { scrollEditorToAnchor } from "../anchor-navigation"
import { useDocStore, type Document } from "../use-doc-store"
import { useTabsStore } from "../use-tabs-store"
import { newTabKey } from "../workspace-tree-utils"
import { findWikiLinkItem, normalizeWikiLinkTarget } from "../wiki-links"
import type { MarkdownAutosaveActions, UseFileActionsParams } from "./types"

export function useWikiNavigation({
  vault,
  treeItems,
  refreshTree,
  handleApplyMutation,
  handleSelect,
}: Pick<UseFileActionsParams, "vault" | "treeItems" | "refreshTree"> &
  Pick<MarkdownAutosaveActions, "handleApplyMutation"> & {
    handleSelect: (fileId: string) => Promise<void>
  }) {
  const t = i18n.t.bind(i18n)
  const { setDoc } = useDocStore.getState()
  const { setTabs, setActiveTabKey } = useTabsStore.getState()
  const handleWikiLinkClick = React.useCallback(
    async (rawLink: string) => {
      if (!vault) return
      const target = normalizeWikiLinkTarget(rawLink)
      if (!target) return
      const clean = (rawLink.split("|")[0] ?? rawLink).trim()
      const hash = clean.indexOf("#")
      const caret = clean.indexOf("^")
      const index = hash !== -1 && caret !== -1 ? Math.min(hash, caret) : hash !== -1 ? hash : caret
      const anchor = index === -1 ? null : clean.slice(index)
      const existing = findWikiLinkItem(treeItems, target, vault)
      if (existing) {
        await handleSelect(existing.id)
        scrollEditorToAnchor(anchor)
        return
      }
      try {
        const result = await createNote(vault, vault, target.split("/").pop() ?? target)
        handleApplyMutation(result)
        await refreshTree()
        const id = result.primaryId ?? result.primaryPath
        if (!id) return
        const note = await readNote(vault, id)
        const title = target.split("/").pop() ?? target
        const document: Document = {
          id,
          title,
          content: "",
          created: t("time.justNow"),
          modified: t("time.justNow"),
          wordCount: 0,
          path: result.primaryPath ?? id,
          revision: note.revision,
          source: note.source,
        }
        setDoc(id, document)
        const key = newTabKey()
        setTabs((previous) => [
          ...previous,
          { key, kind: "document", fileId: id, title, history: [id], historyIndex: 0 },
        ])
        setActiveTabKey(key)
      } catch (error) {
        console.error("Failed to open wiki link:", error)
      }
    },
    [
      handleApplyMutation,
      handleSelect,
      refreshTree,
      setActiveTabKey,
      setDoc,
      setTabs,
      t,
      treeItems,
      vault,
    ],
  )
  return { handleWikiLinkClick, scrollEditorToAnchor }
}

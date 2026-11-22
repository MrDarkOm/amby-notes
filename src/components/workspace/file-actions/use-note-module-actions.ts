import * as React from "react"
import i18n from "@/lib/i18n"
import { logger } from "@/lib/logger"
import { operationErrorCode } from "@/lib/operation-errors"
import {
  createNoteFromTemplate,
  createNoteTemplate,
  openDailyNote,
  readNote,
  type FsMutationResult,
} from "@/lib/storage"
import { useAppNoticesStore } from "../notices/use-app-notices-store"
import { useDocStore } from "../use-doc-store"
import { useTabsStore } from "../use-tabs-store"
import { findTreeItem } from "../workspace-tree-utils"
import type { MarkdownAutosaveActions, UseFileActionsParams } from "./types"

function stemOf(path: string): string {
  const name = path.replace(/\\/gu, "/").split("/").pop() ?? path
  return name.replace(/\.md$/iu, "")
}

/**
 * The Templates and Daily notes modules in the workspace: today's note opens (created by Rust
 * when missing) and a note made from a template opens in the current tab.
 */
export function useNoteModuleActions({
  vault,
  treeItems,
  handleApplyMutation,
  handleSelect,
  releaseUnusedDocumentBuffers,
}: Pick<UseFileActionsParams, "vault" | "treeItems"> &
  Pick<MarkdownAutosaveActions, "handleApplyMutation" | "releaseUnusedDocumentBuffers"> & {
    handleSelect: (fileId: string) => Promise<void>
  }) {
  /** Opens a note the tree does not know yet: the one a creation has just made. */
  const openCreated = React.useCallback(
    async (result: FsMutationResult) => {
      if (!vault) return
      handleApplyMutation(result)
      const id = result.primaryId ?? result.primaryPath
      if (!id) return
      const note = await readNote(vault, id)
      const title = stemOf(result.primaryPath ?? id)
      useDocStore.getState().setDoc(id, {
        id,
        title,
        content: note.content,
        created: i18n.t("time.justNow"),
        modified: i18n.t("time.justNow"),
        wordCount: 0,
        path: result.primaryPath ?? id,
        revision: note.revision,
        source: note.source,
        noteId: id,
      })
      useTabsStore.getState().openItem({ kind: "document", fileId: id, title })
      void releaseUnusedDocumentBuffers()
    },
    [handleApplyMutation, releaseUnusedDocumentBuffers, vault],
  )

  const handleOpenDailyNote = React.useCallback(async () => {
    if (!vault) return
    try {
      const daily = await openDailyNote()
      if (daily.mutation) {
        await openCreated(daily.mutation)
        return
      }
      const existing = findTreeItem(treeItems, daily.path)
      if (existing) await handleSelect(existing.id)
    } catch (error) {
      logger.warn("daily.open_failed", { failureCode: operationErrorCode(error) })
      useAppNoticesStore.getState().post({
        id: "daily-note-open-failed",
        level: "warning",
        titleKey: "notices.app.dailyNoteFailed.title",
        lineKey: "notices.app.dailyNoteFailed.line",
      })
    }
  }, [handleSelect, openCreated, treeItems, vault])

  /** Rejects when the note cannot be made, so the dialog can say so and stay open. */
  const handleNewFromTemplate = React.useCallback(
    async (parentPath: string | null, name: string, template: string) => {
      if (!vault) return
      const result = await createNoteFromTemplate(parentPath ?? vault, name, template)
      logger.info("file.create_from_template", { name })
      await openCreated(result)
    },
    [openCreated, vault],
  )

  /** A new template, opened so it can be filled; rejects when it cannot be made. */
  const handleNewTemplate = React.useCallback(
    async (name: string) => {
      if (!vault) return
      const result = await createNoteTemplate(name)
      logger.info("file.create_template", { name })
      await openCreated(result)
    },
    [openCreated, vault],
  )

  return { handleOpenDailyNote, handleNewFromTemplate, handleNewTemplate }
}

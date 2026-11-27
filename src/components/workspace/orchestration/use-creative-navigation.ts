import type { ProjectCatalog } from "@/lib/bindings"
import { useTabsStore } from "../use-tabs-store"
import { creativeTabTarget, parseCreativeFileId } from "../creative/creative-history"
import { flushEditorSerializations } from "../tiptap/editor-serialization-lifecycle"
import * as React from "react"
import { useTranslation } from "react-i18next"

interface UseCreativeNavigationParams {
  projectCatalog: ProjectCatalog | null
}

export function useCreativeNavigation({ projectCatalog }: UseCreativeNavigationParams) {
  const { t } = useTranslation()
  // A workshop page opens in the current tab like a note, so Back and Forward pass through it
  // (and the notes it opens) in one history.
  const openCreativeTab = React.useCallback(
    (projectId: string, sectionId?: string, inNewTab = false) => {
      flushEditorSerializations()
      useTabsStore
        .getState()
        .openItem(creativeTabTarget(projectCatalog, t, projectId, sectionId), inNewTab)
    },
    [projectCatalog, t],
  )

  // Editors are cached with the props they were made with; the latest opener is read at the click.
  const openCreativeTabRef = React.useRef(openCreativeTab)
  openCreativeTabRef.current = openCreativeTab
  const stableOpenCreativeTab = React.useCallback(
    (projectId: string, sectionId?: string) => openCreativeTabRef.current(projectId, sectionId),
    [],
  )

  // A section tab of the page is a step of the history too; it never jumps to another tab.
  const openCreativeSection = React.useCallback(
    (projectId: string, sectionId: string) => {
      flushEditorSerializations()
      const target = creativeTabTarget(projectCatalog, t, projectId, sectionId)
      // The tab already carries the page's name (a universe's is read from its card).
      const current = useTabsStore.getState()
      const active = current.tabs.find((tab) => tab.key === current.activeTabKey)
      const here = active ? parseCreativeFileId(active.fileId) : null
      useTabsStore
        .getState()
        .openItem(
          here?.projectId === projectId ? { ...target, title: active!.title } : target,
          false,
          {
            inPlace: true,
          },
        )
    },
    [projectCatalog, t],
  )

  const openDatabaseTab = React.useCallback(
    (databaseId: string, title: string, inNewTab = false) => {
      const target = { kind: "database" as const, fileId: databaseId, title }
      if (inNewTab) {
        useTabsStore.getState().openItem(target, true)
        return
      }
      useTabsStore.getState().openItem(target)
    },
    [],
  )
  return { openDatabaseTab, openCreativeTab, stableOpenCreativeTab, openCreativeSection }
}

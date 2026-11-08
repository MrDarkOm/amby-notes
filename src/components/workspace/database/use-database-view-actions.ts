import type { DatabaseSummary, DatabaseViewSummary } from "@/lib/storage"
import * as React from "react"

import { useTranslation } from "react-i18next"

import { confirm } from "@/lib/confirm"
import { confirmations } from "@/lib/confirmations"
import { logger } from "@/lib/logger"

import {
  createDatabaseView,
  deleteDatabaseView,
  duplicateDatabaseView,
  getDatabaseView,
  renameDatabaseView,
  reorderDatabaseViews,
  setDefaultDatabaseView,
  updateDatabaseViewConfig,
} from "@/lib/storage"
import { useDatabaseStore } from "./database-store"

interface UseDatabaseViewActionsParams {
  setMutationError: React.Dispatch<React.SetStateAction<string | null>>
  setMutationBusy: React.Dispatch<React.SetStateAction<boolean>>
  mutationBusy: boolean
  onCatalogChanged: (() => Promise<void>) | undefined
  retry: () => Promise<void>
  setSelectedViewId: (next: string | null) => void
  database: DatabaseSummary | undefined
  vaultGeneration: number | null
  databaseId: string
  isDatabaseLocked: boolean
  activeView: DatabaseViewSummary | undefined
  initialPresentation: { layout: "gallery"; openMode: "fullPage" } | undefined
}

export function useDatabaseViewActions({
  setMutationError,
  setMutationBusy,
  mutationBusy,
  onCatalogChanged,
  retry,
  setSelectedViewId,
  database,
  vaultGeneration,
  databaseId,
  isDatabaseLocked,
  activeView,
  initialPresentation,
}: UseDatabaseViewActionsParams) {
  const { t } = useTranslation()
  const [viewDialogOpen, setViewDialogOpen] = React.useState(false)
  const [viewName, setViewName] = React.useState("")
  const [viewLayout, setViewLayout] = React.useState<
    "table" | "board" | "list" | "gallery" | "chart"
  >("table")

  const [isLinkCopied, setIsLinkCopied] = React.useState(false)

  const openCreateViewDialog = React.useCallback(() => {
    setViewName(t("databaseLayouts.table"))
    setViewLayout("table")
    setMutationError(null)
    setViewDialogOpen(true)
  }, [t, setMutationError])

  const refreshDatabaseViews = React.useCallback(
    async (viewIdToSelect?: string) => {
      const refreshResults = await Promise.allSettled([onCatalogChanged?.(), retry()])
      const refreshFailure = refreshResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      )
      if (refreshFailure) {
        setMutationError(
          refreshFailure.reason instanceof Error
            ? refreshFailure.reason.message
            : String(refreshFailure.reason),
        )
      }
      if (viewIdToSelect) setSelectedViewId(viewIdToSelect)
    },
    [onCatalogChanged, retry, setSelectedViewId, setMutationError],
  )

  // The order of the view tabs while one is dragged; it follows the catalog otherwise.
  const [viewOrder, setViewOrder] = React.useState<string[]>([])
  const catalogViews = database?.views
  React.useEffect(() => {
    setViewOrder(catalogViews?.map((view) => view.viewId) ?? [])
  }, [catalogViews])
  const tabViews = React.useMemo(() => {
    const views = catalogViews ?? []
    const ordered = viewOrder
      .map((id) => views.find((view) => view.viewId === id))
      .filter((view): view is NonNullable<typeof view> => Boolean(view))
    // A view the order does not know yet (just created) goes last.
    return [...ordered, ...views.filter((view) => !viewOrder.includes(view.viewId))]
  }, [catalogViews, viewOrder])
  const viewOrderRef = React.useRef(tabViews)
  viewOrderRef.current = tabViews
  const persistViewOrder = React.useCallback(async () => {
    const currentGeneration = vaultGeneration ?? useDatabaseStore.getState().vaultGeneration
    const ids = viewOrderRef.current.map((view) => view.viewId)
    if (
      currentGeneration === null ||
      !database?.manifestRevision ||
      ids.join() === (database.views ?? []).map((view) => view.viewId).join()
    ) {
      return
    }
    setMutationError(null)
    try {
      await reorderDatabaseViews({
        expectedGeneration: currentGeneration,
        databaseId: database.databaseId,
        expectedManifestRevision: database.manifestRevision,
        viewIds: ids,
      })
      logger.info("database.reorder_views", { databaseId, viewCount: ids.length })
      await refreshDatabaseViews()
    } catch (error) {
      logger.error("database.view_action_failed", { databaseId, viewDialogMode: "reorder", error })
      setMutationError(error instanceof Error ? error.message : String(error))
      // Put the tabs back in the saved order.
      setViewOrder(database.views.map((view) => view.viewId))
    }
  }, [database, databaseId, refreshDatabaseViews, vaultGeneration, setMutationError])

  const changeActiveViewLayout = React.useCallback(
    async (newLayout: "table" | "board" | "list" | "gallery" | "chart") => {
      const targetDatabaseId = database?.databaseId ?? databaseId
      const currentGeneration = vaultGeneration ?? useDatabaseStore.getState().vaultGeneration
      if (
        currentGeneration === null ||
        !database?.manifestRevision ||
        isDatabaseLocked ||
        mutationBusy ||
        !activeView ||
        activeView.layout === newLayout
      )
        return
      setMutationBusy(true)
      setMutationError(null)
      try {
        const doc = await getDatabaseView({
          expectedGeneration: currentGeneration,
          databaseId: targetDatabaseId,
          viewId: activeView.viewId,
          expectedViewRevision: activeView.revision,
        })
        const config = JSON.parse(doc.configJson)
        config.layout = newLayout
        await updateDatabaseViewConfig({
          expectedGeneration: currentGeneration,
          databaseId: targetDatabaseId,
          viewId: activeView.viewId,
          expectedViewRevision: doc.revision,
          configJson: JSON.stringify(config),
        })
        await refreshDatabaseViews(activeView.viewId)
      } catch (error) {
        setMutationError(error instanceof Error ? error.message : String(error))
      } finally {
        setMutationBusy(false)
      }
    },
    [
      activeView,
      database?.databaseId,
      database?.manifestRevision,
      databaseId,
      isDatabaseLocked,
      mutationBusy,
      refreshDatabaseViews,
      vaultGeneration,
      setMutationBusy,
      setMutationError,
    ],
  )

  // The host's first-time presentation (see `initialPresentation`): one write to the view,
  // through the same commands as the layout menu, and a mark so it is not repeated.
  const presentedRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    const currentGeneration = vaultGeneration
    if (
      !initialPresentation ||
      currentGeneration === null ||
      !database?.manifestRevision ||
      isDatabaseLocked ||
      mutationBusy ||
      !activeView ||
      presentedRef.current === databaseId
    )
      return
    const markKey = `amby:database:initial-presentation:${databaseId}`
    try {
      if (window.localStorage.getItem(markKey)) {
        presentedRef.current = databaseId
        return
      }
    } catch {
      // Without storage the mark cannot be kept, so nothing is rewritten at every opening.
      return
    }
    presentedRef.current = databaseId
    const view = activeView
    void (async () => {
      try {
        const doc = await getDatabaseView({
          expectedGeneration: currentGeneration,
          databaseId,
          viewId: view.viewId,
          expectedViewRevision: view.revision,
        })
        const config = JSON.parse(doc.configJson) as Record<string, unknown>
        const toGallery = view.layout === "table"
        const toFullPage = typeof config.openMode !== "string"
        if (toGallery) config.layout = initialPresentation.layout
        if (toFullPage) config.openMode = initialPresentation.openMode
        if (toGallery || toFullPage) {
          await updateDatabaseViewConfig({
            expectedGeneration: currentGeneration,
            databaseId,
            viewId: view.viewId,
            expectedViewRevision: doc.revision,
            configJson: JSON.stringify(config),
          })
          await refreshDatabaseViews(view.viewId)
        }
        window.localStorage.setItem(markKey, "1")
      } catch {
        // Left as it was; the next opening tries again.
        presentedRef.current = null
      }
    })()
  }, [
    activeView,
    database?.manifestRevision,
    databaseId,
    initialPresentation,
    isDatabaseLocked,
    mutationBusy,
    refreshDatabaseViews,
    vaultGeneration,
  ])

  const copyLinkToView = React.useCallback(async () => {
    if (!activeView) return
    const link = `amby://database/${databaseId}?view=${activeView.viewId}`
    try {
      await navigator.clipboard.writeText(link)
      setIsLinkCopied(true)
      setTimeout(() => setIsLinkCopied(false), 2000)
    } catch {
      // Ignore
    }
  }, [activeView, databaseId])

  // Renames the active view from the settings panel; a failure puts the old name back.
  const renameActiveView = React.useCallback(
    async (name: string) => {
      const next = name.trim()
      const view = database?.views.find((candidate) => candidate.viewId === activeView?.viewId)
      const currentGeneration = vaultGeneration ?? useDatabaseStore.getState().vaultGeneration
      if (!view || !next || next === view.title || currentGeneration === null || isDatabaseLocked) {
        return
      }
      setMutationError(null)
      try {
        await renameDatabaseView({
          expectedGeneration: currentGeneration,
          databaseId: database?.databaseId ?? databaseId,
          viewId: view.viewId,
          expectedViewRevision: view.revision,
          name: next,
        })
        logger.info("database.rename_view", { databaseId, viewId: view.viewId, name: next })
        await refreshDatabaseViews(view.viewId)
      } catch (error) {
        logger.error("database.view_action_failed", { databaseId, viewDialogMode: "rename", error })
        setMutationError(error instanceof Error ? error.message : String(error))
        throw error
      }
    },
    [
      activeView?.viewId,
      database?.databaseId,
      database?.views,
      databaseId,
      isDatabaseLocked,
      refreshDatabaseViews,
      vaultGeneration,
      setMutationError,
    ],
  )

  const saveViewDialog = React.useCallback(async () => {
    const targetDatabaseId = database?.databaseId ?? databaseId
    const currentGeneration = vaultGeneration ?? useDatabaseStore.getState().vaultGeneration
    if (
      currentGeneration === null ||
      !database?.manifestRevision ||
      isDatabaseLocked ||
      !viewName.trim() ||
      mutationBusy
    )
      return
    setMutationBusy(true)
    setMutationError(null)
    try {
      const created = await createDatabaseView({
        expectedGeneration: currentGeneration,
        databaseId: targetDatabaseId,
        expectedManifestRevision: database.manifestRevision,
        name: viewName.trim(),
        layout: viewLayout,
      })
      logger.info("database.create_view", {
        databaseId: targetDatabaseId,
        viewId: created.viewId,
        name: viewName.trim(),
        layout: viewLayout,
      })
      setViewDialogOpen(false)
      await refreshDatabaseViews(created.viewId)
    } catch (error) {
      logger.error("database.view_action_failed", {
        databaseId: targetDatabaseId,
        viewDialogMode: "create",
        error,
      })
      setMutationError(error instanceof Error ? error.message : String(error))
    } finally {
      setMutationBusy(false)
    }
  }, [
    database?.databaseId,
    database?.manifestRevision,
    databaseId,
    isDatabaseLocked,
    mutationBusy,
    refreshDatabaseViews,
    vaultGeneration,
    viewLayout,
    viewName,
    setMutationBusy,
    setMutationError,
  ])

  const mutateView = React.useCallback(
    async (action: "duplicate" | "delete" | "default", targetViewId: string) => {
      const targetDatabaseId = database?.databaseId ?? databaseId
      const currentGeneration = vaultGeneration ?? useDatabaseStore.getState().vaultGeneration
      if (
        currentGeneration === null ||
        !database?.manifestRevision ||
        isDatabaseLocked ||
        mutationBusy
      )
        return
      const target = database.views.find((view) => view.viewId === targetViewId)
      if (!target) return
      if (
        action === "delete" &&
        !(await confirm(confirmations.deleteDatabaseView({ name: target.title })))
      )
        return
      setMutationBusy(true)
      setMutationError(null)
      try {
        if (action === "duplicate") {
          const duplicate = await duplicateDatabaseView({
            expectedGeneration: currentGeneration,
            databaseId: targetDatabaseId,
            viewId: target.viewId,
            expectedViewRevision: target.revision,
            expectedManifestRevision: database.manifestRevision,
          })
          logger.info("database.duplicate_view", {
            databaseId: targetDatabaseId,
            viewId: target.viewId,
            newViewId: duplicate.viewId,
          })
          await refreshDatabaseViews(duplicate.viewId)
        } else if (action === "default") {
          await setDefaultDatabaseView({
            expectedGeneration: currentGeneration,
            databaseId: targetDatabaseId,
            viewId: target.viewId,
            expectedViewRevision: target.revision,
            expectedManifestRevision: database.manifestRevision,
          })
          logger.info("database.set_default_view", {
            databaseId: targetDatabaseId,
            viewId: target.viewId,
          })
          await refreshDatabaseViews(target.viewId)
        } else {
          await deleteDatabaseView({
            expectedGeneration: currentGeneration,
            databaseId: targetDatabaseId,
            viewId: target.viewId,
            expectedViewRevision: target.revision,
            expectedManifestRevision: database.manifestRevision,
          })
          logger.info("database.delete_view", {
            databaseId: targetDatabaseId,
            viewId: target.viewId,
          })
          const fallback = database.views.find((view) => view.viewId !== target.viewId)?.viewId
          await refreshDatabaseViews(fallback)
        }
      } catch (error) {
        logger.error("database.mutate_view_failed", {
          databaseId: targetDatabaseId,
          action,
          targetViewId,
          error,
        })
        setMutationError(error instanceof Error ? error.message : String(error))
      } finally {
        setMutationBusy(false)
      }
    },
    [
      database,
      databaseId,
      isDatabaseLocked,
      mutationBusy,
      refreshDatabaseViews,
      vaultGeneration,
      setMutationBusy,
      setMutationError,
    ],
  )

  return {
    mutateView,
    openCreateViewDialog,
    tabViews,
    setViewOrder,
    persistViewOrder,
    viewDialogOpen,
    setViewDialogOpen,
    viewName,
    setViewName,
    viewLayout,
    setViewLayout,
    saveViewDialog,
    isLinkCopied,
    renameActiveView,
    changeActiveViewLayout,
    copyLinkToView,
  }
}

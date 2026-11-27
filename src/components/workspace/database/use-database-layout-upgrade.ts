import * as React from "react"
import { resolveDatabaseLayoutPort } from "@/lib/storage"
import { errorType, logger } from "@/lib/logger"
import { flushAutosaveGeneration } from "../autosave/autosave-lifecycle"
import { useAppNoticesStore, type AppNotice } from "../notices/use-app-notices-store"
import { useVaultStore } from "../use-vault-store"

export function useDatabaseLayoutUpgrade() {
  const vault = useVaultStore((state) => state.vault)
  const generation = useVaultStore((state) => state.generation)
  const backendGeneration = useVaultStore((state) => state.backendGeneration)
  const switching = useVaultStore((state) => state.switching)
  React.useEffect(() => {
    if (!vault || backendGeneration === null || switching) return
    let alive = true
    let running = false
    const id = `database-layout:${generation}`
    const port = resolveDatabaseLayoutPort()
    const current = () =>
      alive &&
      !useVaultStore.getState().switching &&
      useVaultStore.getState().vault === vault &&
      useVaultStore.getState().backendGeneration === backendGeneration
    const dismiss = () => useAppNoticesStore.getState().dismiss(id)
    const patch = (lineKey: string, busy: boolean): void => {
      useAppNoticesStore.setState((state) => ({
        notices: state.notices.map((notice) =>
          notice.id === id
            ? {
                ...notice,
                lineKey,
                action: {
                  labelKey: busy ? "databaseLayout.updating" : "databaseLayout.update",
                  busy,
                  run,
                },
              }
            : notice,
        ),
      }))
    }
    const run = async (): Promise<void> => {
      if (running || !current()) return
      running = true
      patch("databaseLayout.updatingLine", true)
      try {
        const saved = await flushAutosaveGeneration(generation)
        if (!saved.flushed) throw new Error("databaseLayoutUnsaved")
        if (!current()) return
        const status = await port.upgrade(backendGeneration)
        if (!current()) return
        if (status.pendingDatabases === 0) dismiss()
        else patch("databaseLayout.line", false)
      } catch (error) {
        logger.warn("database.layout_upgrade_failed", { errorType: errorType(error) })
        if (current()) patch("databaseLayout.failed", false)
      } finally {
        running = false
      }
    }
    const post = (lineKey: string, action: boolean) => {
      const notice: AppNotice = {
        id,
        level: "decision",
        titleKey: "databaseLayout.title",
        lineKey,
        ...(action ? { action: { labelKey: "databaseLayout.update", busy: false, run } } : {}),
      }
      useAppNoticesStore.getState().post(notice)
    }
    void port
      .scan(backendGeneration)
      .then((status) => {
        if (current() && status.pendingDatabases > 0) post("databaseLayout.line", true)
      })
      .catch((error: unknown) => {
        logger.warn("database.layout_scan_failed", { errorType: errorType(error) })
        if (current()) post("databaseLayout.scanFailed", true)
      })
    return () => {
      alive = false
      dismiss()
    }
  }, [vault, generation, backendGeneration, switching])
}

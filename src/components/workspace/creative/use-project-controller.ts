import * as React from "react"
import { listen } from "@tauri-apps/api/event"
import { isTauri, listProjects, refreshProjects, type ProjectChangedPayload } from "@/lib/storage"
import { adoptAsyncDisposer } from "@/lib/async-disposable"
import { useDatabaseStore } from "../database/database-store"
import { useProjectStore } from "./project-store"

interface ProjectControllerOptions {
  enabled: boolean
  vaultGeneration: number | null
}

const REFRESH_DELAY_MS = 150

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Keeps the project catalog current: reads it once the database catalog is
 * ready (sections resolve through databases), and re-reads after every
 * `project:changed` event from the watcher and every database catalog change.
 */
export function useProjectController({ enabled, vaultGeneration }: ProjectControllerOptions) {
  const reset = useProjectStore((state) => state.reset)
  const setLoading = useProjectStore((state) => state.setLoading)
  const setCatalog = useProjectStore((state) => state.setCatalog)
  const setError = useProjectStore((state) => state.setError)
  const setDisabled = useProjectStore((state) => state.setDisabled)
  const setRefresh = useProjectStore((state) => state.setRefresh)
  const databaseStatus = useDatabaseStore((state) => state.catalogStatus)
  const databases = useDatabaseStore((state) => state.databases)
  const ready = enabled && vaultGeneration !== null && databaseStatus === "ready"
  const generationRef = React.useRef(vaultGeneration)
  generationRef.current = vaultGeneration

  React.useEffect(() => {
    reset()
    if (!enabled) setDisabled()
  }, [enabled, reset, setDisabled, vaultGeneration])

  /** `rebuild` re-reads the files; without it the Rust index is read as it is. */
  const refresh = React.useCallback(
    async (rebuild = false) => {
      const generation = generationRef.current
      if (generation === null) return
      setLoading()
      try {
        setCatalog(rebuild ? await refreshProjects(generation) : await listProjects())
      } catch (error) {
        setError(errorMessage(error))
      }
    },
    [setCatalog, setError, setLoading],
  )

  React.useEffect(() => {
    setRefresh(refresh)
    return () => setRefresh(null)
  }, [refresh, setRefresh])

  // The catalog of databases changed (one was created, moved or renamed): the
  // sections of every project resolve against it again.
  React.useEffect(() => {
    if (ready) void refresh()
  }, [databases, ready, refresh])

  React.useEffect(() => {
    if (!ready || !isTauri()) return undefined
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false
    const schedule = () => {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        if (!cancelled) void refresh(true)
      }, REFRESH_DELAY_MS)
    }
    const registration = listen<ProjectChangedPayload>("project:changed", (event) => {
      if (event.payload.generation === generationRef.current) schedule()
    })
    const dispose = adoptAsyncDisposer(registration, () => {})
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
      dispose()
    }
  }, [ready, refresh])

  return { refresh }
}

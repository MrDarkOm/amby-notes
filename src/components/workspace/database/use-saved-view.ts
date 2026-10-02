import * as React from "react"
import {
  getDatabaseView,
  listDatabases,
  updateDatabaseViewConfig,
  type DatabaseViewSummary,
} from "@/lib/storage"
import { logger } from "@/lib/logger"
import {
  applySettingsPatch,
  EMPTY_SETTINGS,
  mergePatches,
  parseViewSettings,
  settingsAfter,
  type SettingsPatch,
  type ViewSettings,
} from "./view-config"

const SAVE_DELAY_MS = 400
const MAX_REBASES = 4

export interface UseSavedViewOptions {
  databaseId: string
  vaultGeneration: number | null
  /** Summary of the active view; `null` keeps settings in memory only. */
  view: Pick<DatabaseViewSummary, "viewId" | "revision"> | null
  /** Locked databases keep changes local: the backend refuses view writes. */
  persist: boolean
  /** After a successful write, so the owner can refresh its view catalog. */
  onSaved?: () => void | Promise<void>
}

export interface SavedView {
  settings: ViewSettings
  /** False until the view document was read (or when there is no view). */
  ready: boolean
  error: string | null
  update: (patch: SettingsPatch) => void
  /** Writes pending changes now; `true` when nothing is left unsaved. */
  flush: () => Promise<boolean>
}

/** Everything one view's writes need. A new context starts per view, so a late
 * write can never reach another view. */
interface ViewContext {
  databaseId: string
  viewId: string
  generation: number
  doc: string | null
  revision: string | null
  pending: SettingsPatch | null
  timer: ReturnType<typeof setTimeout> | null
  writing: Promise<void> | null
  active: boolean
}

function isConflict(error: unknown): boolean {
  return error instanceof Error && /revision conflict/i.test(error.message)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The persisted settings of one view: widths, wrapping, frozen column, hidden
 * fields, filter, sorts and open mode. This hook is their only writer.
 *
 * Changes apply locally at once and are written after a short pause. A write
 * that finds the view changed elsewhere (another window) is re-applied on top of
 * the newer document, so different settings changed in two windows both survive;
 * only the same setting changed twice keeps the later value.
 */
export function useSavedView({
  databaseId,
  vaultGeneration,
  view,
  persist,
  onSaved,
}: UseSavedViewOptions): SavedView {
  const viewId = view?.viewId ?? null
  const summaryRevision = view?.revision ?? null
  const [settings, setSettings] = React.useState<ViewSettings>(EMPTY_SETTINGS)
  const [ready, setReady] = React.useState(viewId === null)
  const [error, setError] = React.useState<string | null>(null)
  const ctxRef = React.useRef<ViewContext | null>(null)
  const latest = React.useRef({ persist, onSaved })
  latest.current = { persist, onSaved }

  const writePending = React.useCallback(async (ctx: ViewContext) => {
    for (let attempt = 0; attempt <= MAX_REBASES; attempt += 1) {
      const patch = ctx.pending
      if (!patch || ctx.doc === null || ctx.revision === null) return
      if (!latest.current.persist) {
        ctx.pending = null
        return
      }
      ctx.pending = null
      try {
        const nextDoc = applySettingsPatch(ctx.doc, patch)
        const result = await updateDatabaseViewConfig({
          expectedGeneration: ctx.generation,
          databaseId: ctx.databaseId,
          viewId: ctx.viewId,
          expectedViewRevision: ctx.revision,
          configJson: nextDoc,
        })
        ctx.doc = nextDoc
        ctx.revision = result.viewRevision
        if (ctx.active) setError(null)
        await latest.current.onSaved?.()
      } catch (failure) {
        ctx.pending = ctx.pending ? mergePatches(patch, ctx.pending) : patch
        if (!isConflict(failure) || attempt === MAX_REBASES) {
          logger.error("database.save_view_failed", {
            databaseId: ctx.databaseId,
            viewId: ctx.viewId,
            error: failure,
          })
          if (ctx.active) setError(message(failure))
          return
        }
        // Another window changed the view: take its document as the new base.
        try {
          const databases = await listDatabases()
          const current = databases
            .find((database) => database.databaseId === ctx.databaseId)
            ?.views.find((candidate) => candidate.viewId === ctx.viewId)
          if (!current) {
            if (ctx.active) setError("View no longer exists")
            return
          }
          const fresh = await getDatabaseView({
            expectedGeneration: ctx.generation,
            databaseId: ctx.databaseId,
            viewId: ctx.viewId,
            expectedViewRevision: current.revision,
          })
          ctx.doc = fresh.configJson
          ctx.revision = fresh.revision
          if (ctx.active) {
            setSettings(settingsAfter(parseViewSettings(fresh.configJson), ctx.pending ?? {}))
          }
        } catch (reloadFailure) {
          if (ctx.active) setError(message(reloadFailure))
          return
        }
      }
    }
  }, [])

  const flushContext = React.useCallback(
    async (ctx: ViewContext | null): Promise<boolean> => {
      if (!ctx) return true
      if (ctx.timer) {
        clearTimeout(ctx.timer)
        ctx.timer = null
      }
      // Writes never overlap: a flush during a write waits for it and goes again.
      while (ctx.writing) await ctx.writing
      if (!ctx.pending) return true
      const run = writePending(ctx).finally(() => {
        ctx.writing = null
      })
      ctx.writing = run
      await run
      return !ctx.pending
    },
    [writePending],
  )

  const flush = React.useCallback(() => flushContext(ctxRef.current), [flushContext])

  const update = React.useCallback(
    (patch: SettingsPatch) => {
      setSettings((current) => settingsAfter(current, patch))
      const ctx = ctxRef.current
      if (!ctx) return
      ctx.pending = ctx.pending ? mergePatches(ctx.pending, patch) : patch
      if (ctx.timer) clearTimeout(ctx.timer)
      ctx.timer = setTimeout(() => void flushContext(ctx), SAVE_DELAY_MS)
    },
    [flushContext],
  )

  // One context per view; leaving a view flushes its pending changes first.
  React.useEffect(() => {
    if (!viewId || vaultGeneration === null) {
      ctxRef.current = null
      setSettings(EMPTY_SETTINGS)
      setReady(viewId === null)
      return
    }
    const ctx: ViewContext = {
      databaseId,
      viewId,
      generation: vaultGeneration,
      doc: null,
      revision: null,
      pending: null,
      timer: null,
      writing: null,
      active: true,
    }
    ctxRef.current = ctx
    setSettings(EMPTY_SETTINGS)
    setReady(false)
    return () => {
      void flushContext(ctx).finally(() => {
        ctx.active = false
      })
      if (ctxRef.current === ctx) ctxRef.current = null
    }
  }, [databaseId, viewId, vaultGeneration, flushContext])

  // Load the document, and reload after a change made elsewhere.
  React.useEffect(() => {
    const ctx = ctxRef.current
    if (!ctx || summaryRevision === null) return
    // Our own write (or a queued one) already is the newest state.
    if (ctx.revision === summaryRevision || ctx.pending || ctx.writing) return
    let cancelled = false
    setError(null)
    getDatabaseView({
      expectedGeneration: ctx.generation,
      databaseId: ctx.databaseId,
      viewId: ctx.viewId,
      expectedViewRevision: summaryRevision,
    }).then(
      (doc) => {
        if (cancelled || ctxRef.current !== ctx || ctx.pending || ctx.writing) return
        ctx.doc = doc.configJson
        ctx.revision = doc.revision
        setSettings(parseViewSettings(doc.configJson))
        setReady(true)
      },
      (failure) => {
        if (cancelled || ctxRef.current !== ctx) return
        setError(message(failure))
        setReady(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [databaseId, viewId, summaryRevision, vaultGeneration])

  React.useEffect(() => {
    const onHide = () => void flush()
    window.addEventListener("pagehide", onHide)
    return () => window.removeEventListener("pagehide", onHide)
  }, [flush])

  return { settings, ready, error, update, flush }
}
